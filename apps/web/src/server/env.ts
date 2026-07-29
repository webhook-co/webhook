import "server-only";

import type {
  ConnectedApp,
  EmailChangeService,
  LoginMethodsService,
  OnboardingProfileService,
  OnboardingStateDto,
} from "@webhook-co/contract";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { resolveEmailMode, type EmailMode } from "@webhook-co/shared/email-transport";

import {
  parseBillingMode,
  parseFreeEventCap,
  parseStripePlans,
  type BillingMode,
  type DeliveryDispatcherRpc,
  type IngestCacheEvictorRpc,
  type IngestUrlRevealerRpc,
  type SecretSealer,
  type StripePlans,
} from "@webhook-co/shared";

import type { SessionExchangeBinding } from "./session-exchange";

/**
 * The app. Worker's runtime config + secrets. Secrets are Cloudflare Secrets Store bindings in prod
 * (read via `.get()`) and plain strings in dev/test; URLs default to the prod hosts. Read per-request
 * — `getCloudflareContext()` is only available inside a workerd request, so outside one (node/test/
 * `next dev` without bindings) we fall back to `process.env` + dev defaults. The session secret fails
 * **closed in production**: a missing binding throws rather than signing sessions with a dev default.
 */

const PROD_AUTH_BASE_URL = "https://auth.webhook.co";
const DEV_AUTH_BASE_URL = "http://localhost:3001";
const PROD_APP_BASE_URL = "https://app.webhook.co";
const DEV_APP_BASE_URL = "http://localhost:3000";
// Dev-only signing key — sessions minted with it are worthless in prod (which fails closed below).
const DEV_SESSION_SECRET = "dev-only-insecure-session-secret-not-for-production-use";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** The Worker env when inside a workerd request; `{}` otherwise (node/test/dev-without-bindings). */
function workerEnv(): Record<string, unknown> {
  try {
    return (getCloudflareContext().env ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Resolve a value that may be a Secrets Store binding (`.get()`) or a plain string. */
async function readSecret(value: unknown): Promise<string | null> {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (value && typeof (value as { get?: unknown }).get === "function") {
    const resolved = await (value as { get: () => Promise<unknown> }).get();
    return typeof resolved === "string" && resolved.length > 0 ? resolved : null;
  }
  return null;
}

// Dev-only base64 secrets (32 bytes each) — usable only in dev/test against a local DB; prod fails closed.
const DEV_CREDENTIAL_PEPPER = btoa("dev-only-credential-pepper-32by!");
const DEV_AUDIT_CHAIN_KEY = btoa("dev-only-audit-chain-key-32bytes");
const DEV_LISTEN_TICKET_KEY = btoa("dev-only-listen-ticket-key-32byt");

/**
 * Read a secret by binding name: the Secrets Store binding (prod, via `.get()`) or `process.env`
 * (dev/test), falling back to a fixed dev value outside production. **Production fails closed** — a
 * missing secret throws rather than using a dev default (the session signer / pepper / audit key must
 * be real in prod).
 */
async function readConfiguredSecret(name: string, devFallback: string): Promise<string> {
  const fromBinding = await readSecret((workerEnv() as Record<string, unknown>)[name]);
  const fromProcess = process.env[name];
  const secret = fromBinding ?? (fromProcess && fromProcess.length > 0 ? fromProcess : null);
  if (secret) return secret;
  if (isProduction()) {
    throw new Error(`${name} is not configured`);
  }
  return devFallback;
}

/** The HMAC secret that signs the app. session cookie. */
export function getSessionSecret(): Promise<string> {
  return readConfiguredSecret("SESSION_TOKEN_SECRET", DEV_SESSION_SECRET);
}

/** The base64 credential pepper (>=32 bytes) — keys the api-key HMAC; byte-identical across api/engine/mcp/web. */
export function getCredentialPepper(): Promise<string> {
  return readConfiguredSecret("CREDENTIAL_PEPPER", DEV_CREDENTIAL_PEPPER);
}

/** The base64 audit-chain HMAC key — signs the `key_minted` audit row (the same key every surface signs with). */
export function getAuditChainKey(): Promise<string> {
  return readConfiguredSecret("AUDIT_CHAIN_HMAC_KEY", DEV_AUDIT_CHAIN_KEY);
}

/**
 * The base64 32-byte HMAC key for the dashboard live-events LISTEN TICKET — byte-identical to the engine's
 * LISTEN_TICKET_KEY (web mints, the engine verifies). A short-lived signed grant that lets the browser open
 * the engine's `/listen` WebSocket without an api-key bearer.
 */
export function getListenTicketKey(): Promise<string> {
  return readConfiguredSecret("LISTEN_TICKET_KEY", DEV_LISTEN_TICKET_KEY);
}

/**
 * The `AUTH_SESSION_EXCHANGE` Cloudflare service binding — auth.'s SessionExchange WorkerEntrypoint, reachable
 * as a direct RPC (no public HTTP hop). Bound only at deploy (the gen-wrangler-prod overlay); `undefined` in
 * dev/preview and before the binding is provisioned, so `exchangeTicket` transparently falls back to the
 * public `POST /session/exchange` fetch. Detected structurally (an object with an `exchange` method) so a
 * mis-shaped binding never masquerades as a working RPC.
 */
export function getSessionExchangeBinding(): SessionExchangeBinding | undefined {
  const binding = workerEnv().AUTH_SESSION_EXCHANGE;
  if (binding && typeof (binding as { exchange?: unknown }).exchange === "function") {
    return binding as SessionExchangeBinding;
  }
  return undefined;
}

/** auth.'s AccountDeleter WorkerEntrypoint (slice 2.2), reachable over a Cloudflare service binding.
 *  Only auth. (webhook_auth) may touch the identity realm, so account erasure RPCs it. */
export interface AccountDeleterBinding {
  deleteAccount(userId: string): Promise<{ deleted: boolean }>;
}

/** The bound AUTH_ACCOUNT_DELETER entrypoint, or undefined when unbound (dev / pre-provision). */
export function getAccountDeleterBinding(): AccountDeleterBinding | undefined {
  const binding = workerEnv().AUTH_ACCOUNT_DELETER;
  if (binding && typeof (binding as { deleteAccount?: unknown }).deleteAccount === "function") {
    return binding as AccountDeleterBinding;
  }
  return undefined;
}

/** auth.'s ConnectedApps WorkerEntrypoint — a user's active OAuth grants live in auth.'s OAUTH_KV, which the
 *  dashboard can't read locally, so it RPCs this binding. Keyed by the SERVER-verified session userId. */
export interface ConnectedAppsBinding {
  list(userId: string): Promise<ConnectedApp[]>;
  revoke(userId: string, grantId: string): Promise<boolean>;
}

/** The bound AUTH_CONNECTED_APPS entrypoint, or undefined when unbound (dev / pre-provision). */
export function getConnectedAppsBinding(): ConnectedAppsBinding | undefined {
  const binding = workerEnv().AUTH_CONNECTED_APPS;
  if (
    binding &&
    typeof (binding as { list?: unknown }).list === "function" &&
    typeof (binding as { revoke?: unknown }).revoke === "function"
  ) {
    return binding as ConnectedAppsBinding;
  }
  return undefined;
}

/** auth.'s OnboardingProfile WorkerEntrypoint — first/last name + `onboardedAt` live on the identity `user`
 *  table, which only auth. (webhook_auth) may write, so onboarding reads/completes over this binding. Keyed by
 *  the SERVER-verified session userId; the write's timestamp is minted auth-side, never caller-supplied. The
 *  wire shape is the single {@link OnboardingProfileService} contract both apps type against. */
export type OnboardingProfileBinding = OnboardingProfileService;

// Re-exported so onboarding-logic (which types its input on the state slice) keeps a local import path.
export type { OnboardingStateDto };

/** The bound AUTH_ONBOARDING entrypoint, or undefined when unbound (dev / pre-provision). */
export function getOnboardingBinding(): OnboardingProfileBinding | undefined {
  const binding = workerEnv().AUTH_ONBOARDING;
  // NOTE: a bound Cloudflare RPC stub is a Proxy that fabricates a callable for ANY property name, so these
  // typeof checks only distinguish BOUND (a real stub) from UNBOUND (undefined in dev / pre-provision) — they
  // canNOT detect whether the deployed auth worker actually has a given method. A call to a method the
  // deployed worker lacks (a web-before-auth deploy window) throws at call time; callers must catch that
  // rather than rely on this returning undefined.
  if (
    binding &&
    typeof (binding as { read?: unknown }).read === "function" &&
    typeof (binding as { complete?: unknown }).complete === "function"
  ) {
    return binding as OnboardingProfileBinding;
  }
  return undefined;
}

export type EmailChangeBinding = EmailChangeService;
export type LoginMethodsBinding = LoginMethodsService;

/** The bound AUTH_EMAIL_CHANGE entrypoint (auth.'s `EmailChanger`), or undefined when unbound (dev /
 *  pre-provision). Keyed by the SERVER-verified userId. As with getOnboardingBinding, the structural check
 *  only distinguishes BOUND from UNBOUND — a method-not-found in a deploy window throws at call time. */
export function getEmailChangeBinding(): EmailChangeBinding | undefined {
  const binding = workerEnv().AUTH_EMAIL_CHANGE;
  if (
    binding &&
    typeof (binding as { start?: unknown }).start === "function" &&
    typeof (binding as { commit?: unknown }).commit === "function"
  ) {
    return binding as EmailChangeBinding;
  }
  return undefined;
}

/** The bound AUTH_LOGIN_METHODS entrypoint (auth.'s `LoginMethods`), or undefined when unbound. */
export function getLoginMethodsBinding(): LoginMethodsBinding | undefined {
  const binding = workerEnv().AUTH_LOGIN_METHODS;
  if (
    binding &&
    typeof (binding as { list?: unknown }).list === "function" &&
    typeof (binding as { unlink?: unknown }).unlink === "function"
  ) {
    return binding as LoginMethodsBinding;
  }
  return undefined;
}

/**
 * The `PROVIDER_SECRET_SEALER` Cloudflare service binding — the engine's seal-only `ProviderSecretSealer`
 * WorkerEntrypoint, reachable as a direct RPC (no public HTTP hop). It is **write-only**: it wraps a
 * plaintext under the KMS envelope and can never decrypt, so binding it into the web worker is strictly
 * weaker than the secrets the worker already holds. Bound only at deploy (the gen-wrangler-prod overlay,
 * mirroring api/mcp); `undefined` in dev/preview and before provisioning — the destinations mutations
 * fail closed (a create/rotate that needs to mint a signing secret errors rather than storing plaintext).
 * Detected structurally (an object with a `sealString` method) so a mis-shaped binding never masquerades
 * as a working sealer.
 */
export function getProviderSecretSealer(): SecretSealer | undefined {
  const binding = workerEnv().PROVIDER_SECRET_SEALER;
  if (binding && typeof (binding as { sealString?: unknown }).sealString === "function") {
    return binding as SecretSealer;
  }
  return undefined;
}

/**
 * The `DELIVERY_DISPATCHER` Cloudflare service binding — the engine's `DeliveryDispatcher` WorkerEntrypoint,
 * reachable as a direct RPC. It is the ONLY place the outbound replay POST + the authoritative connect-time
 * SSRF guard happen; the web worker never fetches a destination itself. Bound only at deploy (the
 * gen-wrangler-prod overlay, mirroring api); `undefined` in dev/preview and before provisioning — the replay
 * mutation fails closed (a replay errors rather than silently no-op'ing). Detected structurally (an object
 * with a `deliver` method) so a mis-shaped binding never masquerades as a working dispatcher.
 */
export function getDeliveryDispatcher(): DeliveryDispatcherRpc | undefined {
  const binding = workerEnv().DELIVERY_DISPATCHER;
  if (binding && typeof (binding as { deliver?: unknown }).deliver === "function") {
    return binding as DeliveryDispatcherRpc;
  }
  return undefined;
}

/**
 * The `INGEST_URL_REVEALER` Cloudflare service binding — the engine's `IngestUrlRevealer` WorkerEntrypoint,
 * reachable as a direct RPC (S8-remainder / ADR-0101). The engine is the sole KEK holder, so the ingest-URL
 * UNSEAL happens ONLY there; the web worker passes identifiers `(orgId, endpointId)` and gets back the
 * plaintext token — it never sees or supplies the sealed blob. Bound only at deploy (the gen-wrangler-prod
 * overlay, mirroring api/mcp); `undefined` in dev/preview and before provisioning — the endpoint-detail
 * reveal degrades to "rotate to reveal" (never a crash). Detected structurally (an object with a
 * `revealIngestToken` method) so a mis-shaped binding never masquerades as a working revealer.
 */
export function getIngestUrlRevealer(): IngestUrlRevealerRpc | undefined {
  const binding = workerEnv().INGEST_URL_REVEALER;
  if (
    binding &&
    typeof (binding as { revealIngestToken?: unknown }).revealIngestToken === "function"
  ) {
    return binding as IngestUrlRevealerRpc;
  }
  return undefined;
}

/**
 * The `INGEST_CACHE_EVICTOR` Cloudflare service binding — the engine's `IngestCacheEvictor` WorkerEntrypoint
 * (WS3). The web tier flips `org_limits.pause_policy` AND durably reconciles `ingest_paused` in one DB tx, so
 * enforcement is already correct; this binding only asks the engine to evict the org's ingest-token entries
 * from the KV cache the engine owns, so the flip is picked up on the next cold miss instead of at the TTL.
 * Bound only at deploy (the gen-wrangler-prod overlay); `undefined` in dev/preview and before provisioning —
 * the overage toggle then degrades to TTL-freshness (best-effort, logged), NEVER to a wrong durable state.
 * Detected structurally (an object with an `evictOrgIngestCache` method) so a mis-shaped binding can't
 * masquerade.
 */
export function getIngestCacheEvictor(): IngestCacheEvictorRpc | undefined {
  const binding = workerEnv().INGEST_CACHE_EVICTOR;
  if (
    binding &&
    typeof (binding as { evictOrgIngestCache?: unknown }).evictOrgIngestCache === "function"
  ) {
    return binding as IngestCacheEvictorRpc;
  }
  return undefined;
}

/**
 * The cookieless ingest apex (e.g. https://wbhk.my) the endpoint create/rotate one-time URL is built on
 * (`${apex}/<token>`). A COMMITTED wrangler var (not a secret — see apps/web/wrangler.jsonc); defaults to
 * the prod apex outside a bound request (node/test/dev). The endpoint mutations validate it fail-closed
 * before minting, so a misconfigured value throws rather than returning a broken URL.
 */
export function getIngestBaseUrl(): string {
  const fromBinding = workerEnv().INGEST_BASE_URL;
  const url =
    (typeof fromBinding === "string" && fromBinding.length > 0 ? fromBinding : null) ??
    (process.env.INGEST_BASE_URL && process.env.INGEST_BASE_URL.length > 0
      ? process.env.INGEST_BASE_URL
      : null);
  return url ?? "https://wbhk.my";
}

/**
 * The `wss://…/listen` URL the dashboard live-events client opens for an endpoint tail. Derived from the
 * same committed ingest apex the one-time endpoint URL is built on (`getIngestBaseUrl`) — the `/listen`
 * WebSocket lives on the cookieless `wbhk.my` apex — converting the http(s) scheme to ws(s) and appending
 * `/listen`. Single-sourced here (never hardcoded in the client) so a self-host / preview apex flows
 * through automatically.
 */
export function getListenWsUrl(): string {
  const base = getIngestBaseUrl().replace(/\/+$/, "");
  const wsBase = base.startsWith("https://")
    ? `wss://${base.slice("https://".length)}`
    : base.startsWith("http://")
      ? `ws://${base.slice("http://".length)}`
      : base;
  return `${wsBase}/listen`;
}

/**
 * The injected Free-tier event cap (FREE_EVENT_CAP) the usage view shows a rowless (Free) org — the SAME
 * tier figure the engine cap producer enforces at (S4.3b), so the dashboard never renders "uncapped" while
 * the org would be paused at it. A deploy-injected var (a tier figure, kept out of the repo); unset/invalid
 * → null (uncapped, the fail-safe). Parsed via the shared strict `parseFreeEventCap`. MUST match every
 * other worker's FREE_EVENT_CAP (the same GH var into engine/api/mcp/web).
 */
export function getFreeEventCap(): number | null {
  const fromBinding = workerEnv().FREE_EVENT_CAP;
  const raw =
    (typeof fromBinding === "string" && fromBinding.length > 0 ? fromBinding : null) ??
    process.env.FREE_EVENT_CAP ??
    null;
  return parseFreeEventCap(raw);
}

/**
 * BILLING_MODE (off | test | live) — gates every Stripe flow (S4.4). Fail-safe: unset/garbage → off, so
 * the dashboard shows no billing UI and no Stripe call is made unless deliberately enabled. `live` is the
 * founder-gated real-charge mode. Read from the same injected deploy var as the other workers.
 */
export function getBillingMode(): BillingMode {
  const fromBinding = workerEnv().BILLING_MODE;
  const raw =
    (typeof fromBinding === "string" && fromBinding.length > 0 ? fromBinding : null) ??
    process.env.BILLING_MODE ??
    null;
  return parseBillingMode(raw);
}

/**
 * ASYNC_ORG_DELETION (#665) — route an org delete through the async requestOrgDeletion (mark `deleting`; the
 * webhook_reaper cron drains the rows) instead of the synchronous deleteOrgWithAudit. Fail-safe OFF: only the
 * literal "true"/"1"/"on" enables it, so until the reaper role + Hyperdrive are provisioned in prod, deletes
 * stay on the proven synchronous path — flipping this before the reaper is live would strand orgs `deleting`
 * with nothing to reap them. Read from the same injected deploy var as the other workers.
 */
export function getAsyncOrgDeletionEnabled(): boolean {
  const fromBinding = workerEnv().ASYNC_ORG_DELETION;
  const raw =
    (typeof fromBinding === "string" && fromBinding.length > 0 ? fromBinding : null) ??
    process.env.ASYNC_ORG_DELETION ??
    null;
  return raw === "true" || raw === "1" || raw === "on";
}

/**
 * The Stripe secret key (sk_test_ / sk_live_) — a Secrets Store binding in prod, or process.env in dev.
 * Null when unset (the caller treats that as "billing not configured" and no-ops). NEVER logged.
 */
export function getStripeSecretKey(): Promise<string | null> {
  return readSecret((workerEnv() as Record<string, unknown>).STRIPE_SECRET_KEY).then(
    (fromBinding) =>
      fromBinding ??
      (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.length > 0
        ? process.env.STRIPE_SECRET_KEY
        : null),
  );
}

/**
 * The self-serve plan → Stripe PRICE ID map (the `STRIPE_PLANS` deploy var — ids, NOT amounts, so no price
 * figure enters the repo). `parseStripePlans` is fail-closed: a malformed or half-configured map yields
 * null and the dashboard shows no Checkout, rather than sending a wrong line item to a real customer.
 */
export function getStripePlans(): StripePlans | null {
  const v = workerEnv().STRIPE_PLANS;
  const raw =
    (typeof v === "string" && v.length > 0 ? v : null) ??
    (process.env.STRIPE_PLANS && process.env.STRIPE_PLANS.length > 0
      ? process.env.STRIPE_PLANS
      : null);
  return parseStripePlans(raw);
}

/**
 * The Stripe Billing Portal `configuration` id (`bpc_…`) to PIN the portal session to (S6c-ii). The
 * no-refund contract (ADR-0112: `subscription_cancel.mode = at_period_end`, `proration_behavior = none`,
 * `subscription_update` disabled) otherwise rests on an unversioned dashboard DEFAULT that a console click
 * could silently change. Pinning names the exact configuration. A `bpc_` id is not a secret — a plain deploy
 * var, like STRIPE_PLANS. Null/unset ⇒ the portal falls back to the account default (the current behaviour),
 * so this is dark-safe until the var is set.
 */
export function getStripePortalConfigId(): string | null {
  const v = workerEnv().STRIPE_PORTAL_CONFIGURATION_ID;
  const raw =
    (typeof v === "string" && v.length > 0 ? v : null) ??
    (process.env.STRIPE_PORTAL_CONFIGURATION_ID &&
    process.env.STRIPE_PORTAL_CONFIGURATION_ID.length > 0
      ? process.env.STRIPE_PORTAL_CONFIGURATION_ID
      : null);
  return raw;
}

/**
 * The Resend API key for transactional mail (currently: the invite email). A Secrets Store binding in prod,
 * process.env in dev. NULL when unset — the caller treats that as "email not configured" and falls back to
 * the copy-link, so an unbound secret degrades the invite flow rather than breaking it. NEVER logged.
 */
export function getResendApiKey(): Promise<string | null> {
  return readSecret((workerEnv() as Record<string, unknown>).RESEND_API_KEY).then(
    (fromBinding) =>
      fromBinding ??
      (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.length > 0
        ? process.env.RESEND_API_KEY
        : null),
  );
}

/**
 * Where transactional mail goes for this surface. Resolved from EMAIL_MODE across BOTH the Worker env and
 * `process.env` — apps/web runs under OpenNext, where a `.dev.vars` entry surfaces in either place
 * depending on how the dev server was started, and getResendApiKey already reads both for the same reason.
 *
 * The fence (refusing log mode against a Secrets Store binding) lives in the shared resolver.
 */
export function getEmailMode(): EmailMode {
  const worker = workerEnv() as Record<string, unknown>;
  return resolveEmailMode({
    EMAIL_MODE: (worker.EMAIL_MODE as string | undefined) ?? process.env.EMAIL_MODE,
    // Only the Worker env is consulted for the fence's input, and deliberately so: the fence asks "is this
    // a Secrets Store binding", and a process.env value is a string by construction, so it could never
    // answer yes. Adding the process.env fallback here for symmetry with getResendApiKey would read as a
    // protection while changing no verdict — the asymmetry is the honest shape.
    RESEND_API_KEY: worker.RESEND_API_KEY,
  });
}

/** This app's own origin — used to turn a relative accept path into the absolute link an email must carry. */
export function getAppBaseUrl(): string {
  const fromBinding = workerEnv().APP_BASE_URL;
  const url =
    (typeof fromBinding === "string" && fromBinding.length > 0 ? fromBinding : null) ??
    (process.env.APP_BASE_URL && process.env.APP_BASE_URL.length > 0
      ? process.env.APP_BASE_URL
      : null);
  if (url) return url;
  return isProduction() ? PROD_APP_BASE_URL : DEV_APP_BASE_URL;
}

/** The auth. origin to backchannel the A-SX `/session/exchange` against. */
export function getAuthBaseUrl(): string {
  const fromBinding = workerEnv().AUTH_BASE_URL;
  const url =
    (typeof fromBinding === "string" && fromBinding.length > 0 ? fromBinding : null) ??
    (process.env.AUTH_BASE_URL && process.env.AUTH_BASE_URL.length > 0
      ? process.env.AUTH_BASE_URL
      : null);
  if (url) return url;
  return isProduction() ? PROD_AUTH_BASE_URL : DEV_AUTH_BASE_URL;
}
