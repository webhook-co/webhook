// A1b — the auth Worker's runtime bindings + secrets, accessed per-request via getCloudflareContext()
// (env is not available at module load on workerd). Secrets are Cloudflare Secrets Store bindings in prod
// and plain strings in dev/test; `readSecretBinding` handles both, so the runtime resolves them the same
// way regardless of source. Hyperdrive is typed structurally (just the connectionString we use).

import { readSecretBinding } from "@webhook-co/shared";
import { resolveEmailMode } from "@webhook-co/shared/email-transport";

export interface HyperdriveBinding {
  /** The PostgreSQL connection URI Hyperdrive proxies (verify-full to Neon). */
  connectionString: string;
}

/** A secret value: a Secrets Store binding (prod) or a plain string (dev/test) — readSecretBinding's input. */
type Secret = Parameters<typeof readSecretBinding>[0];

export interface AuthEnv {
  /**
   * Better Auth's identity-table CRUD connects as the **webhook_auth** role (migration 0016: DML on
   * user/session/account/verification). DISTINCT from the repo's `HYPERDRIVE_AUTHN` (webhook_authn
   * bearer-verify, SELECT-only) — do NOT reuse that; webhook_app is also ungranted on the identity tables.
   */
  HYPERDRIVE_AUTH: HyperdriveBinding;
  /** webhook_app role — the personal-org bootstrap path (A1b-2), a separate driver/role. */
  HYPERDRIVE_TENANT: HyperdriveBinding;
  /**
   * webhook_sweeper role (ADR-0055) — bound for the daily cross-org expiry cron only (scheduled()), NOT any
   * request path, so it's OPTIONAL here (readSweepEnv validates it where it's actually used). DELETE-only on
   * the two token tables; distinct credential from TENANT/AUTH/AUTHN.
   */
  HYPERDRIVE_SWEEPER?: HyperdriveBinding;
  BETTER_AUTH_SECRET: Secret;
  /** Base64 credential pepper — keys the bootstrap's default-endpoint ingest-token HMAC. */
  CREDENTIAL_PEPPER: Secret;
  /** Public origin of this auth surface; defaults to the prod host. */
  AUTH_BASE_URL?: string;
  /** Public origin of the app. dashboard the handoff ticket targets + is audience-bound to; defaults to
   *  the prod host (urls.ts). Set in dev (.dev.vars) so the handoff redirects to localhost, not prod. */
  APP_BASE_URL?: string;
  GOOGLE_CLIENT_ID: Secret;
  GOOGLE_CLIENT_SECRET: Secret;
  GITHUB_CLIENT_ID: Secret;
  GITHUB_CLIENT_SECRET: Secret;
  RESEND_API_KEY: Secret;
  /**
   * Local-dev hermetic flags. Absent in production (kept out of every deployed config by
   * scripts/dev-mode-guard.mjs); see the block above REQUIRED_SECRETS for what each relaxes and how each
   * is fenced. `EMAIL_MODE=log` prints mail to the console; `OAUTH_MODE=optional` drops unconfigured
   * social providers.
   */
  EMAIL_MODE?: string;
  OAUTH_MODE?: string;
  /**
   * Cloudflare Turnstile siteverify secret — keys the Better Auth captcha plugin gating the magic-link send
   * (defense-in-depth on the public, email-triggering endpoint). OPTIONAL in the type so local/test runs
   * boot without it (the plugin is simply not wired); always provisioned in prod (gen-wrangler-prod.mjs).
   */
  TURNSTILE_SECRET_KEY?: Secret;
  /**
   * The rate-limit counter store (KVNamespace) — the durable magic-link send throttle (makeAuth) keys here,
   * replacing Better Auth's per-isolate in-memory limiter. Optional in the type (so AuthEnv readers needn't
   * all require it); always bound in prod (wrangler.jsonc) — when absent the throttle is simply skipped.
   */
  RATELIMIT_KV?: unknown;
}

/** Secrets resolved to plain strings (Better Auth + the hasher take strings). */
export interface ResolvedAuthSecrets {
  betterAuthSecret: string;
  credentialPepper: string;
  googleClientId: string;
  googleClientSecret: string;
  githubClientId: string;
  githubClientSecret: string;
  resendApiKey: string;
  /** Cloudflare Turnstile siteverify secret — present only when TURNSTILE_SECRET_KEY is bound (prod);
   *  absent → the captcha plugin is not wired (see buildAuthConfig). */
  turnstileSecretKey?: string;
}

const REQUIRED_SECRETS = [
  "BETTER_AUTH_SECRET",
  "CREDENTIAL_PEPPER",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "RESEND_API_KEY",
] as const;

// --- Hermetic local-dev modes -------------------------------------------------------------------------
// A contributor with no Google/GitHub OAuth app and no Resend account must still be able to boot this
// Worker and sign in. Two flags relax the contract above — and both are EXPLICIT on purpose.
//
// The tempting alternative, "a missing OAuth secret just means that provider is off", was rejected: it
// makes a production secret-rotation typo silently disable Google sign-in instead of failing loudly on the
// first request. The whole value of this file is that a misconfig is obvious. So the relaxation has to be
// something you deliberately turn on, never something you fall into.
//
// Each flag is fenced against the PRODUCTION SECRET SHAPE: a Secrets Store binding (an object with
// `.get()`) is what gen-wrangler-prod.mjs emits and what only a deployed Worker has; dev and test pass
// plain strings. Asking for a hermetic mode on a Worker holding real store-backed secrets is a
// misconfiguration serious enough to refuse outright rather than interpret.
//
// That runtime fence covers the deployed shape. Keeping these keys out of committed config, the deploy
// overlay and the workflows is the SECOND fence — scripts/dev-mode-guard.mjs. Neither is total alone.

const OAUTH_SECRETS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

/** Whether the social-login secrets are mandatory. `required` is production; `optional` is local dev. */
export type OAuthMode = "required" | "optional";

/**
 * Resolve OAUTH_MODE, failing closed: an unknown value throws rather than picking a behaviour, and
 * `optional` is refused outright when any OAuth secret arrives as a Secrets Store binding.
 */
export function resolveOAuthMode(env: Record<string, unknown>): OAuthMode {
  // Blank is UNSET, not a typo — `.dev.vars` writes an unconfigured key as `OAUTH_MODE=`. See the same
  // note in @webhook-co/shared/email-transport.
  const mode = typeof env.OAUTH_MODE === "string" ? env.OAUTH_MODE.trim() : env.OAUTH_MODE;
  if (mode === undefined || mode === "" || mode === "required") return "required";
  if (mode !== "optional") {
    throw new Error(`OAUTH_MODE must be "required" or "optional" (got ${JSON.stringify(mode)})`);
  }
  const fromStore = OAUTH_SECRETS.filter(
    (name) => typeof (env[name] as { get?: unknown } | null)?.get === "function",
  );
  if (fromStore.length > 0) {
    throw new Error(
      `refusing OAUTH_MODE=optional: ${fromStore.join(", ")} ${
        fromStore.length === 1 ? "is a" : "are"
      } Secrets Store binding${fromStore.length === 1 ? "" : "s"}, which only a deployed Worker has. ` +
        "Optional mode drops social login when it is unconfigured — it is a local-dev substitute and must " +
        "never run in production, where a missing OAuth secret has to fail loudly.",
    );
  }
  return "optional";
}

/**
 * Which social providers are configured, for the LOGIN PAGE to decide which buttons to render.
 *
 * Without this the page renders "Continue with Google" unconditionally, and under OAUTH_MODE=optional that
 * button posts to a provider Better Auth was never given — producing exactly the broken button that
 * buildAuthConfig's `socialProviders` goes out of its way to avoid. The server decides; the form is told.
 *
 * This tests PRESENCE (`secretPresent`), whereas buildAuthConfig tests the RESOLVED value being non-empty.
 * The two disagree for exactly one input: a Secrets Store binding that resolves to an empty string. That
 * is REACHABLE, not merely unlikely — the login page's `isSignedIn()` short-circuits on a missing session
 * cookie (resolve-signed-in.ts) and so never resolves a secret, which is precisely the signed-out visitor
 * who sees this page. In that state the button renders and then 500s on click.
 *
 * That is accepted rather than fixed here: resolving all four OAuth secrets on every render of a public,
 * signed-out page would add Secrets Store reads to the hottest unauthenticated path in the product, to
 * detect a mis-provisioning that the same request already surfaces loudly the moment anyone clicks. An
 * empty store secret is a deploy fault, and it is not this function's job to paper over one.
 */
export function configuredSocialProviders(env: Record<string, unknown>): {
  google: boolean;
  github: boolean;
} {
  return {
    google: secretPresent(env.GOOGLE_CLIENT_ID) && secretPresent(env.GOOGLE_CLIENT_SECRET),
    github: secretPresent(env.GITHUB_CLIENT_ID) && secretPresent(env.GITHUB_CLIENT_SECRET),
  };
}

/** The secrets the hermetic flags have made optional for this env (empty in production). */
function relaxedSecrets(env: Record<string, unknown>): ReadonlySet<string> {
  const relaxed = new Set<string>();
  if (resolveOAuthMode(env) === "optional") for (const name of OAUTH_SECRETS) relaxed.add(name);
  if (resolveEmailMode(env as { EMAIL_MODE?: string }) === "log") relaxed.add("RESEND_API_KEY");
  return relaxed;
}

/**
 * The resolved-secret field each relaxable env key lands in, so the empty-value check below can tell
 * "hermetically absent" from "mis-provisioned in production". Written out rather than derived from the
 * name: a mechanical SNAKE→camel transform would silently stop matching the day a field is renamed, and
 * this mapping decides whether an empty secret fails closed.
 */
const RELAXABLE_FIELD: Readonly<Record<string, keyof ResolvedAuthSecrets>> = {
  GOOGLE_CLIENT_ID: "googleClientId",
  GOOGLE_CLIENT_SECRET: "googleClientSecret",
  GITHUB_CLIENT_ID: "githubClientId",
  GITHUB_CLIENT_SECRET: "githubClientSecret",
  RESEND_API_KEY: "resendApiKey",
};

/** Read a secret that may legitimately be absent under a hermetic flag; absent resolves to "". */
async function readOptionalSecret(secret: Secret | undefined): Promise<string> {
  return secret === undefined || secret === null ? "" : readSecretBinding(secret);
}

const REQUIRED_BINDINGS = ["HYPERDRIVE_AUTH", "HYPERDRIVE_TENANT"] as const;

/** A secret is present if it's a non-empty string or a Secrets Store binding (an object with `.get()`). */
function secretPresent(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  return typeof (value as { get?: unknown } | null)?.get === "function";
}

/**
 * Validate the Worker env at the request boundary and narrow it to AuthEnv. Fails closed with a clear
 * message (naming the missing key, never its value) on any absent/empty secret or mis-named/malformed
 * Hyperdrive binding — so a misconfig surfaces as an obvious 500 on the first request rather than an
 * empty-secret session signer or an `undefined.connectionString`/`undefined.get()` crash downstream.
 */
export function readAuthEnv(env: Record<string, unknown>): AuthEnv {
  const relaxed = relaxedSecrets(env);
  for (const key of REQUIRED_SECRETS) {
    if (relaxed.has(key)) continue;
    if (!secretPresent(env[key])) {
      throw new Error(`auth env: missing or empty required secret ${key}`);
    }
  }
  for (const key of REQUIRED_BINDINGS) {
    const binding = env[key] as HyperdriveBinding | undefined;
    if (
      !binding ||
      typeof binding.connectionString !== "string" ||
      binding.connectionString.length === 0
    ) {
      throw new Error(`auth env: missing or malformed Hyperdrive binding ${key}`);
    }
  }
  return env as unknown as AuthEnv;
}

/** Resolve every secret to a plain string (Secrets Store `.get()` or pass-through), in parallel. */
// --- A2b-2b: the frozen /token route's env slice ---------------------------------------------------
// Distinct from AuthEnv so the issuer endpoint doesn't drag the better-auth runtime's secrets
// (Google/GitHub/Resend) into its failure surface and vice-versa. /token mints scoped keys + refresh
// handles as webhook_app, so it needs the tenant Hyperdrive, the credential pepper (key/refresh hash),
// the audit-chain HMAC key (the aae1 mint audit), and OAUTH_KV (the provider store getOAuthApi reads to
// unwrap/revoke the opaque grant).
export interface TokenEnv {
  HYPERDRIVE_TENANT: HyperdriveBinding;
  CREDENTIAL_PEPPER: Secret;
  AUDIT_CHAIN_HMAC_KEY: Secret;
  /** The OAuth provider's KV store (KVNamespace) — getOAuthApi(config, env) reads it per request. */
  OAUTH_KV: unknown;
  /** The device-code store (KVNamespace) — the A4b device_code grant polls it. */
  DEVICE_KV: unknown;
  /**
   * The cross-surface resolved-principal cache (KVNamespace). /token needs it because a refresh denied for
   * lost membership REVOKES the grant, and that cascade's child keys must be evicted — a revoked key would
   * otherwise keep resolving from cache until its TTL lapses.
   */
  KV_AUTHZ: unknown;
}

/**
 * Validate + narrow the env for the /token route, fail-closed (naming the missing key, never its value):
 * a misconfig surfaces as an obvious 500 on the first /token request rather than a downstream crash.
 */
export function readTokenEnv(env: Record<string, unknown>): TokenEnv {
  for (const key of ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY"] as const) {
    if (!secretPresent(env[key])) {
      throw new Error(`token env: missing or empty required secret ${key}`);
    }
  }
  const tenant = env.HYPERDRIVE_TENANT as HyperdriveBinding | undefined;
  if (
    !tenant ||
    typeof tenant.connectionString !== "string" ||
    tenant.connectionString.length === 0
  ) {
    throw new Error("token env: missing or malformed Hyperdrive binding HYPERDRIVE_TENANT");
  }
  for (const key of ["OAUTH_KV", "DEVICE_KV", "KV_AUTHZ"] as const) {
    if (env[key] == null || typeof env[key] !== "object") {
      throw new Error(`token env: missing ${key} binding`);
    }
  }
  return env as unknown as TokenEnv;
}

// --- A4b: the /device_authorization env slice ------------------------------------------------------
// /device_authorization validates the client (getOAuthApi → OAUTH_KV) and mints a device code (DEVICE_KV).
// No DB/secret — no key is minted until the /token poll, so it carries neither the tenant pool nor pepper.
export interface DeviceAuthorizeEnv {
  /** The OAuth provider's KV store (KVNamespace) — getOAuthApi(config, env).lookupClient reads it. */
  OAUTH_KV: unknown;
  /** The device-code store (KVNamespace). */
  DEVICE_KV: unknown;
}

/** Validate the env for /device_authorization, fail-closed. */
export function readDeviceAuthorizeEnv(env: Record<string, unknown>): DeviceAuthorizeEnv {
  for (const key of ["OAUTH_KV", "DEVICE_KV"] as const) {
    if (env[key] == null || typeof env[key] !== "object") {
      throw new Error(`device_authorization env: missing ${key} binding`);
    }
  }
  return env as unknown as DeviceAuthorizeEnv;
}

// --- A2b-4b: the frozen /revoke route's env slice --------------------------------------------------
// /revoke resolves a presented token to its grant cross-org then revokes it: a whk_ access key needs the
// bearer-verify Hyperdrive (webhook_authn, cross-org by-hash); an rtk_ refresh handle + the grant cascade
// run as webhook_app (HYPERDRIVE_TENANT); the pepper hashes the presented token; the audit key signs the
// grant_revoked entry; KV_AUTHZ is the cross-surface principal cache evicted on revoke.
export interface RevokeEnv {
  HYPERDRIVE_AUTHN: HyperdriveBinding;
  HYPERDRIVE_TENANT: HyperdriveBinding;
  CREDENTIAL_PEPPER: Secret;
  AUDIT_CHAIN_HMAC_KEY: Secret;
  /** The cross-surface principal cache (KVNamespace) api./mcp./engine share — evicted by key hash. */
  KV_AUTHZ: unknown;
}

/**
 * Validate + narrow the env for the /revoke route, fail-closed (naming the missing key, never its value).
 */
export function readRevokeEnv(env: Record<string, unknown>): RevokeEnv {
  for (const key of ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY"] as const) {
    if (!secretPresent(env[key])) {
      throw new Error(`revoke env: missing or empty required secret ${key}`);
    }
  }
  for (const key of ["HYPERDRIVE_AUTHN", "HYPERDRIVE_TENANT"] as const) {
    const binding = env[key] as HyperdriveBinding | undefined;
    if (
      !binding ||
      typeof binding.connectionString !== "string" ||
      binding.connectionString.length === 0
    ) {
      throw new Error(`revoke env: missing or malformed Hyperdrive binding ${key}`);
    }
  }
  if (env.KV_AUTHZ == null || typeof env.KV_AUTHZ !== "object") {
    throw new Error("revoke env: missing KV_AUTHZ binding");
  }
  return env as unknown as RevokeEnv;
}

// --- A2b-5: the introspection WorkerEntrypoint's env slice -----------------------------------------
// mcp (A8) RPCs auth.introspect(token) over a service binding to validate an opaque provider token. The
// only binding the provider's unwrapToken touches is OAUTH_KV (the grant/token store on THIS Worker).
export interface IntrospectEnv {
  /** The OAuth provider's KV store (KVNamespace) — getOAuthApi(config, env).unwrapToken reads it. */
  OAUTH_KV: unknown;
}

/** Validate the env for the introspect entrypoint, fail-closed. */
export function readIntrospectEnv(env: Record<string, unknown>): IntrospectEnv {
  if (env.OAUTH_KV == null || typeof env.OAUTH_KV !== "object") {
    throw new Error("introspect env: missing OAUTH_KV binding");
  }
  return env as unknown as IntrospectEnv;
}

// The Connected Apps entrypoint reads the OAUTH_KV grant store (like introspect) AND, best-effort, resolves
// each grant's bound org from the tenant realm (readOrgIdentity over HYPERDRIVE_TENANT). The tenant binding
// is optional here so the org ENRICHMENT degrades to omitted if it's ever absent — the app LIST (which needs
// only OAUTH_KV) never fails for a missing org read.
export interface ConnectedAppsEnv extends IntrospectEnv {
  HYPERDRIVE_TENANT?: HyperdriveBinding;
}

// --- A3d: the /authorize + /consent/decision env slice ---------------------------------------------
// The consent flow needs: the full Better Auth runtime to resolve the session (so it carries AuthEnv);
// CONSENT_TICKET_KEY (the 32-byte HMAC secret signing the stateless consent ticket); OAUTH_KV (getOAuthApi
// parseAuthRequest/lookupClient/completeAuthorization). HYPERDRIVE_TENANT (in AuthEnv) backs getConsentOrg.
export interface AuthorizeEnv extends AuthEnv {
  /** Base64 of a 32-byte HMAC key — signs/verifies the consent ticket (importConsentTicketKey). */
  CONSENT_TICKET_KEY: Secret;
  /** The OAuth provider's KV store (KVNamespace) — getOAuthApi(config, env) reads it per request. */
  OAUTH_KV: unknown;
  /** The device-code store (KVNamespace) — /consent/decision records a device decision via setDeviceDecision. */
  DEVICE_KV: unknown;
}

/**
 * Validate + narrow the env for the consent endpoints, fail-closed (naming the missing key, never its
 * value): reuses readAuthEnv (the session runtime) then asserts the ticket key + OAUTH_KV + DEVICE_KV.
 */
export function readAuthorizeEnv(env: Record<string, unknown>): AuthorizeEnv {
  readAuthEnv(env);
  if (!secretPresent(env.CONSENT_TICKET_KEY)) {
    throw new Error("authorize env: missing or empty required secret CONSENT_TICKET_KEY");
  }
  for (const key of ["OAUTH_KV", "DEVICE_KV"] as const) {
    if (env[key] == null || typeof env[key] !== "object") {
      throw new Error(`authorize env: missing ${key} binding`);
    }
  }
  return env as unknown as AuthorizeEnv;
}

// --- A4c-3: the /device/verify env slice -----------------------------------------------------------
// The browser device-verify path needs everything the consent endpoints do (AuthorizeEnv: session +
// ticket key + OAUTH_KV + DEVICE_KV) PLUS the rate-limit store (the user-code guess surface).
export interface DeviceVerifyEnv extends AuthorizeEnv {
  /** The rate-limit counter store (KVNamespace) — consumeRateLimit keys the verify guess-throttle here. */
  RATELIMIT_KV: unknown;
}

/** Validate + narrow the env for /device/verify, fail-closed. */
export function readDeviceVerifyEnv(env: Record<string, unknown>): DeviceVerifyEnv {
  readAuthorizeEnv(env);
  if (env.RATELIMIT_KV == null || typeof env.RATELIMIT_KV !== "object") {
    throw new Error("device_verify env: missing RATELIMIT_KV binding");
  }
  return env as unknown as DeviceVerifyEnv;
}

// --- A-SX-2a: the /session/exchange env slice ------------------------------------------------------
// The backchannel redeem consumes the ticket as webhook_app (HYPERDRIVE_TENANT, the org-embedded handle
// routes the tenant) + reads the user profile as webhook_auth (HYPERDRIVE_AUTH, the global `user` table);
// the pepper hashes the presented ticket. No session/cookie (it's a server-to-server call authenticated by
// the single-use ticket), no provider/KV.
export interface SessionExchangeEnv {
  HYPERDRIVE_TENANT: HyperdriveBinding;
  HYPERDRIVE_AUTH: HyperdriveBinding;
  CREDENTIAL_PEPPER: Secret;
  /** The app. origin the ticket's audience must match — MUST be the same value the handoff minted with
   *  (session-handoff-deps). Defaults to the prod host (urls.ts); set in dev (.dev.vars) so a localhost-
   *  minted ticket redeems. Asymmetry here = every exchange 401s. */
  APP_BASE_URL?: string;
}

/** Validate + narrow the env for /session/exchange, fail-closed (naming the missing key, never its value). */
export function readSessionExchangeEnv(env: Record<string, unknown>): SessionExchangeEnv {
  if (!secretPresent(env.CREDENTIAL_PEPPER)) {
    throw new Error("session_exchange env: missing or empty required secret CREDENTIAL_PEPPER");
  }
  for (const key of ["HYPERDRIVE_TENANT", "HYPERDRIVE_AUTH"] as const) {
    const binding = env[key] as HyperdriveBinding | undefined;
    if (
      !binding ||
      typeof binding.connectionString !== "string" ||
      binding.connectionString.length === 0
    ) {
      throw new Error(`session_exchange env: missing or malformed Hyperdrive binding ${key}`);
    }
  }
  return env as unknown as SessionExchangeEnv;
}

// --- ADR-0055: the cross-org expiry cron-sweep env slice -------------------------------------------
// The daily scheduled() sweep connects as the least-privilege webhook_sweeper role (DELETE-only on the two
// token tables) over its OWN Hyperdrive binding — DISTINCT from HYPERDRIVE_TENANT/AUTH/AUTHN, which carry
// other roles. No secret/KV/session: the cron only deletes already-expired rows across all orgs.
export interface SweepEnv {
  /** webhook_sweeper role — the cross-org DELETE-only client the cron prunes expired handles with. */
  HYPERDRIVE_SWEEPER: HyperdriveBinding;
}

/** Validate + narrow the env for the cron sweep, fail-closed (naming the missing key, never its value). */
export function readSweepEnv(env: Record<string, unknown>): SweepEnv {
  const binding = env.HYPERDRIVE_SWEEPER as HyperdriveBinding | undefined;
  if (
    !binding ||
    typeof binding.connectionString !== "string" ||
    binding.connectionString.length === 0
  ) {
    throw new Error("sweep env: missing or malformed Hyperdrive binding HYPERDRIVE_SWEEPER");
  }
  return env as unknown as SweepEnv;
}

// --- S3 Slice 3 PR3c-3b: the cross-org notification-drain env slice --------------------------------
// The scheduled() notification drain connects as the least-privilege webhook_notifier role (read pending
// intents + owner email, flip pending→sent) over its OWN Hyperdrive binding — DISTINCT from the others — and
// sends via the shared RESEND_API_KEY (the same secret the magic-link sender uses).
export interface NotifyEnv {
  /** webhook_notifier role — the cross-org client the drain reads intents + marks-sent with. */
  HYPERDRIVE_NOTIFIER: HyperdriveBinding;
  /** Resend API key (Secrets Store in prod / string in dev). Absent only under EMAIL_MODE=log. */
  RESEND_API_KEY?: Secret;
  /** Local-dev only — see the hermetic-modes block above. */
  EMAIL_MODE?: string;
}

/** Validate + narrow the env for the notification drain, fail-closed (naming the missing key, never its value). */
export function readNotifyEnv(env: Record<string, unknown>): NotifyEnv {
  const binding = env.HYPERDRIVE_NOTIFIER as HyperdriveBinding | undefined;
  if (
    !binding ||
    typeof binding.connectionString !== "string" ||
    binding.connectionString.length === 0
  ) {
    throw new Error("notify env: missing or malformed Hyperdrive binding HYPERDRIVE_NOTIFIER");
  }
  // Under EMAIL_MODE=log the drain prints notifications instead of sending them, so no Resend key is
  // needed. resolveEmailMode refuses log mode against a production secret shape, so this cannot relax the
  // requirement on a deployed Worker.
  if (
    resolveEmailMode(env as { EMAIL_MODE?: string }) === "send" &&
    (env.RESEND_API_KEY === undefined || env.RESEND_API_KEY === null)
  ) {
    throw new Error("notify env: missing RESEND_API_KEY");
  }
  return env as unknown as NotifyEnv;
}

/** Resolve every secret to a plain string (Better Auth + the hasher take strings). */
export async function resolveAuthSecrets(env: AuthEnv): Promise<ResolvedAuthSecrets> {
  const [
    betterAuthSecret,
    credentialPepper,
    googleClientId,
    googleClientSecret,
    githubClientId,
    githubClientSecret,
    resendApiKey,
  ] = await Promise.all([
    readSecretBinding(env.BETTER_AUTH_SECRET),
    readSecretBinding(env.CREDENTIAL_PEPPER),
    readOptionalSecret(env.GOOGLE_CLIENT_ID),
    readOptionalSecret(env.GOOGLE_CLIENT_SECRET),
    readOptionalSecret(env.GITHUB_CLIENT_ID),
    readOptionalSecret(env.GITHUB_CLIENT_SECRET),
    readOptionalSecret(env.RESEND_API_KEY),
  ]);
  const resolved = {
    betterAuthSecret,
    credentialPepper,
    googleClientId,
    googleClientSecret,
    githubClientId,
    githubClientSecret,
    resendApiKey,
  };
  // Fail closed on an EMPTY resolved value — readAuthEnv can't see inside a Secrets Store binding, so a
  // mis-provisioned (empty) store secret only surfaces here. Never sign sessions / mint with an empty key.
  //
  // The hermetic flags carve out EXACTLY the fields they relaxed: under OAUTH_MODE=optional an absent
  // Google secret resolves to "" and that is the intended state, but BETTER_AUTH_SECRET going empty is
  // still a hard failure. The carve-out is per-field, never blanket.
  const relaxedFields = new Set(
    [...relaxedSecrets(env as unknown as Record<string, unknown>)].map(
      (key) => RELAXABLE_FIELD[key],
    ),
  );
  for (const [name, value] of Object.entries(resolved)) {
    if (relaxedFields.has(name as keyof ResolvedAuthSecrets)) continue;
    if (value.length === 0) throw new Error(`auth env: resolved secret ${name} is empty`);
  }
  // Turnstile is OPTIONAL: resolve it only when bound (prod). Present-but-empty is still a misconfig — fail
  // closed rather than wire a keyless gate that would reject every magic-link send (or, worse, pass none).
  if (env.TURNSTILE_SECRET_KEY !== undefined) {
    const turnstileSecretKey = await readSecretBinding(env.TURNSTILE_SECRET_KEY);
    if (turnstileSecretKey.length === 0) {
      throw new Error("auth env: resolved secret turnstileSecretKey is empty");
    }
    return { ...resolved, turnstileSecretKey };
  }
  return resolved;
}

// URL/string constants live in ./urls (dependency-free) so client components can import them without
// pulling this module's server-only deps into the browser bundle. Re-exported for the runtime's imports.
export { APP_BASE_URL, MAGIC_LINK_FROM, PROD_AUTH_BASE_URL, TURNSTILE_ACTION } from "./urls";
