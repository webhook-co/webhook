// Generate the per-environment prod wrangler config for each Worker (engine/api/mcp + the OpenNext web
// dashboard). deploy.yml deploys engine/api/mcp; deploy-web.yml builds OpenNext + deploys web. The
// generator emits every app's wrangler.prod.jsonc each run — each workflow deploys only its own apps.
//
// The committed apps/<app>/wrangler.jsonc carry PLACEHOLDER ids (`<HYPERDRIVE_*_ID>` / `<KV_*_ID>`),
// literal `*-dev` bucket names, and NO secrets_store_secrets/routes — real ids must never be
// committed (no-secrets). This reads the real ids from the ENVIRONMENT (GitHub repo variables in
// CI), token-replaces them, and injects account_id / workers_dev:false / routes (custom domains) /
// secrets_store_secrets — emitting apps/<app>/wrangler.prod.jsonc (gitignored), which the deploy
// step passes to `wrangler deploy -c`. Secret VALUES never appear here — only the store id + names.
//
// Usage: node scripts/gen-wrangler-prod.mjs   (with the required env vars set)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Read a required env var or fail loudly (a missing id must never silently produce a bad config). */
function reqEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

const ACCOUNT_ID = reqEnv("CLOUDFLARE_ACCOUNT_ID");
const STORE = reqEnv("SECRETS_STORE_ID");

// Billing (S4.4/S4.5) ships DARK until provisioned. `BILLING_ON` (BILLING_MODE set + not "off") gates the
// optional Stripe SECRET bindings — they must be injected ONLY once the secret exists in the store, or a
// `wrangler deploy` binding a non-existent secret fails. The runbook provisions the secrets BEFORE setting
// BILLING_MODE, so this order is safe. The optional HYPERDRIVE bindings are gated separately, on their own id
// var (they're billing-independent for meter-audit), by applyOptionalBlock below.
const BILLING_ON = !!(process.env.BILLING_MODE && process.env.BILLING_MODE !== "off");
const whenBilling = (names) => (BILLING_ON ? names : []);

// The internal activation-review endpoint (ADR-0127) needs BOTH its reviewer Hyperdrive and its bearer
// secret to go live; gating the secret on the SAME GH var that gates the Hyperdrive keeps the two halves
// activating/stripping together (set the var → both bound → live; unset → both stripped → 404 dark).
const whenActivationReviewer = (names) =>
  process.env.HYPERDRIVE_ACTIVATION_REVIEWER_ID ? names : [];

/** Escape a value for embedding INSIDE a JSON string literal (quotes, backslashes, control chars). */
const jsonStringBody = (v) => JSON.stringify(v).slice(1, -1);

// placeholder/literal token -> real value (resource ids from the env; bucket dev -> prod).
const TOKEN = {
  "<HYPERDRIVE_TENANT_ID>": reqEnv("HYPERDRIVE_TENANT_ID"),
  // <HYPERDRIVE_CACHED_ID> is gone: the HYPERDRIVE_CACHED binding it filled was read by ZERO source files for
  // its whole life, and its mere existence forced the cache-posture guard to carry a by-name exemption that
  // TWO review rounds walked a cross-tenant leak straight through. The webhook-prod-cached Hyperdrive config
  // and the HYPERDRIVE_CACHED_ID repo var both still exist; only the binding is retired. Re-adding it means
  // re-adding the guard's exemption too — scoped to an (app, binding) pair, never a bare name.
  "<HYPERDRIVE_ANCHOR_ID>": reqEnv("HYPERDRIVE_ANCHOR_ID"),
  // The delivery reconciler's webhook_reconciler Hyperdrive (S3 Slice 3 PR3c-2) — bound to a least-privilege,
  // SELECT-only cross-org Neon role. The operator provisions the role + Hyperdrive and sets the
  // HYPERDRIVE_RECONCILER_ID GH repo var; the deploy workflow must provide it like every other id here.
  "<HYPERDRIVE_RECONCILER_ID>": reqEnv("HYPERDRIVE_RECONCILER_ID"),
  // The metering-rollup cron's webhook_meter Hyperdrive (S4.1) — a least-privilege, SELECT-only cross-org Neon
  // role (enumerate orgs with recent events / a stale-open usage day). The operator provisions the role +
  // Hyperdrive and sets the HYPERDRIVE_METER_ID GH repo var; every workflow that runs this generator must provide it.
  "<HYPERDRIVE_METER_ID>": reqEnv("HYPERDRIVE_METER_ID"),
  "<HYPERDRIVE_AUTHN_ID>": reqEnv("HYPERDRIVE_AUTHN_ID"),
  "<HYPERDRIVE_INGEST_ID>": reqEnv("HYPERDRIVE_INGEST_ID"),
  "<KV_CONFIG_ID>": reqEnv("KV_CONFIG_ID"),
  "<KV_AUTHZ_ID>": reqEnv("KV_AUTHZ_ID"),
  // <OAUTH_KV_ID> removed (A8): mcp is no longer an OAuth issuer, so it has no OAUTH_KV binding. The
  // OAUTH_KV_ID GitHub repo variable is now unused (was mcp-only) and can be retired.
  // auth.webhook.co (deploy slice): the issuer's OWN OAuth grant store + device-code + rate-limit KV, and
  // the webhook_auth Hyperdrive. Every workflow that runs this generator must provide these env vars.
  "<AUTH_OAUTH_KV_ID>": reqEnv("AUTH_OAUTH_KV_ID"),
  "<AUTH_DEVICE_KV_ID>": reqEnv("AUTH_DEVICE_KV_ID"),
  "<AUTH_RATELIMIT_KV_ID>": reqEnv("AUTH_RATELIMIT_KV_ID"),
  "<HYPERDRIVE_AUTH_ID>": reqEnv("HYPERDRIVE_AUTH_ID"),
  // The cross-org expiry cron-sweep's webhook_sweeper Hyperdrive (ADR-0055) — bound to a least-privilege,
  // DELETE-only Neon role. The operator provisions the role + Hyperdrive and sets the HYPERDRIVE_SWEEPER_ID
  // GH repo var; the auth deploy workflow must provide it like every other id here.
  "<HYPERDRIVE_SWEEPER_ID>": reqEnv("HYPERDRIVE_SWEEPER_ID"),
  // The S3 notification-drain's webhook_notifier Hyperdrive (PR3c-3b) — a least-privilege cross-org Neon role
  // (read pending intents + owner email, flip pending→sent). Operator provisions the role + Hyperdrive + sets
  // the HYPERDRIVE_NOTIFIER_ID GH repo var; every workflow that runs this generator must provide it.
  "<HYPERDRIVE_NOTIFIER_ID>": reqEnv("HYPERDRIVE_NOTIFIER_ID"),
  // The Free tier's ONE-TIME LIFETIME event allowance (S4.3 soft-cap; ADR-0004 amended 2026-07-09 — counted
  // over all time, never resets) — a tier figure kept out of the repo. OPTIONAL (not reqEnv):
  // unset → "" → the engine cron treats it as uncapped (fail-safe, no Free-pause enforcement). Set the
  // FREE_EVENT_CAP GH repo var + this workflow env to ENABLE Free enforcement.
  "<FREE_EVENT_CAP>": process.env.FREE_EVENT_CAP ?? "",
  // Billing config VARS (S4.4/S4.5) — all OPTIONAL: unset → "" → the code fail-closes (BILLING_MODE ""→off,
  // empty price/meter → disabled). An empty var is a valid wrangler var, so — unlike the optional Hyperdrive
  // bindings — these substitute in unconditionally. No price/tier figure lives here (ids/names only).
  "<BILLING_MODE>": process.env.BILLING_MODE ?? "",
  // ASYNC_ORG_DELETION (#665) — "true" routes org deletes through the async reaper; else the sync path.
  "<ASYNC_ORG_DELETION>": process.env.ASYNC_ORG_DELETION ?? "",
  // ORPHAN_SWEEP_DELETE (S6c-iii) — "true" enables the orphan-sweep delete; anything else = count-only.
  "<ORPHAN_SWEEP_DELETE>": process.env.ORPHAN_SWEEP_DELETE ?? "",
  "<STRIPE_METER_EVENT_NAME>": process.env.STRIPE_METER_EVENT_NAME ?? "",
  "<STRIPE_METER_ID>": process.env.STRIPE_METER_ID ?? "",
  // STRIPE_PLANS is a JSON map (plan id → {base, overage} price ids) that lands INSIDE a JSON string value,
  // so its quotes must be escaped or the generated wrangler.prod.jsonc is unparseable. `JSON.stringify`
  // then strip the surrounding quotes = exactly the JSON string-body escaping wrangler needs.
  "<STRIPE_PLANS>": jsonStringBody(process.env.STRIPE_PLANS ?? ""),
  // The Billing Portal configuration id (bpc_…, S6c-ii) — pins the no-refund/at-period-end contract to a
  // versioned config instead of the dashboard default. Optional: unset → "" → the portal uses the account
  // default (current behaviour), so it ships dark-safe.
  "<STRIPE_PORTAL_CONFIGURATION_ID>": process.env.STRIPE_PORTAL_CONFIGURATION_ID ?? "",
  "webhook-payloads-dev": "webhook-payloads-prod",
  "webhook-audit-anchors-dev": "webhook-audit-anchors-prod",
  "webhook-avatars-dev": "webhook-avatars-prod",
};

const SHARED = ["CREDENTIAL_PEPPER", "CURSOR_KEY", "AUDIT_CHAIN_HMAC_KEY"];
const secretsBlock = (names) => names.map((n) => ({ binding: n, store_id: STORE, secret_name: n }));

const APPS = {
  engine: {
    domain: "wbhk.my",
    // + LISTEN_TICKET_KEY: the dashboard live-events listen-ticket HMAC key. Shared with web ONLY (web
    //   mints, engine verifies); byte-identical. Not in api/mcp, so appended per-app rather than to SHARED.
    secrets: [
      ...SHARED,
      "KMS_KEY_ARN",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "LISTEN_TICKET_KEY",
      // STRIPE_SECRET_KEY (S4.4c) — the outbound meter-reporter's Stripe key. Bound only when billing is on.
      ...whenBilling(["STRIPE_SECRET_KEY"]),
    ],
    placeholders: [
      "<HYPERDRIVE_TENANT_ID>",
      "<HYPERDRIVE_ANCHOR_ID>",
      "<HYPERDRIVE_RECONCILER_ID>",
      "<HYPERDRIVE_METER_ID>",
      "<HYPERDRIVE_AUTHN_ID>",
      "<HYPERDRIVE_INGEST_ID>",
      "<KV_CONFIG_ID>",
      "<KV_AUTHZ_ID>",
      "<FREE_EVENT_CAP>",
      "<ORPHAN_SWEEP_DELETE>",
      "<BILLING_MODE>",
      "<STRIPE_METER_EVENT_NAME>",
      "<STRIPE_METER_ID>",
      "webhook-payloads-dev",
      "webhook-audit-anchors-dev",
    ],
    // HYPERDRIVE_METER_AUDIT (S4.4d) + HYPERDRIVE_METER_TRANSPORT_AUDIT (WS1) — each kept only when its
    // *_ID GH var is provisioned, else the whole @gen-optional block is stripped so the engine deploys dark.
    optionalHyperdrives: [
      "HYPERDRIVE_METER_AUDIT_ID",
      "HYPERDRIVE_METER_TRANSPORT_AUDIT_ID",
      // data-lifecycle: the payload-purge drain's cross-org role. Unset for now, so the overlay strips
      // the @gen-optional block and the engine deploys dark until the role + Hyperdrive are provisioned.
      "HYPERDRIVE_PURGE_ID",
      // data-lifecycle slice 2.3: the retention-prune drain's cross-org role. Unset for now, so the overlay
      // strips the @gen-optional block and the engine deploys dark until the role + Hyperdrive are
      // provisioned (which also clamps the meter-reconcile lookback — they activate together).
      "HYPERDRIVE_RETENTION_ID",
      // #665: the async org-deletion reaper's cross-org role. Unset for now, so the overlay strips the
      // @gen-optional block and the engine deploys dark until the role + Hyperdrive are provisioned; the
      // reaper cron then skips.
      "HYPERDRIVE_REAPER_ID",
      // PR2b: the free-org-cap reconciler's cross-USER role. Unset for now, so the overlay strips the
      // @gen-optional block and the engine deploys dark until the role + Hyperdrive are provisioned; the
      // reconcile cron then skips.
      "HYPERDRIVE_CAPRECONCILER_ID",
    ],
  },
  api: {
    domain: "api.webhook.co",
    // STRIPE_WEBHOOK_SIGNING_SECRET (S4.5) verifies the inbound webhook signature; STRIPE_SECRET_KEY (WS3)
    // lets the invoice.created TAIL-FLUSH REPORT meter usage outbound. Both bound only when billing is on.
    secrets: [
      ...SHARED,
      // The internal activation weekly-review bearer — bound with the reviewer Hyperdrive (ADR-0127).
      ...whenActivationReviewer(["INTERNAL_REVIEW_TOKEN"]),
      ...whenBilling(["STRIPE_WEBHOOK_SIGNING_SECRET", "STRIPE_SECRET_KEY"]),
    ],
    placeholders: [
      "<HYPERDRIVE_AUTHN_ID>",
      "<HYPERDRIVE_TENANT_ID>",
      "<KV_AUTHZ_ID>",
      // KV_CONFIG: the engine's ingest cache, bound into api ONLY to evict on endpoints.delete/rotate
      // (ADR-0076). Reuses the existing KV_CONFIG_ID GH repo var (no new var) — same namespace as engine.
      "<KV_CONFIG_ID>",
      // FREE_EVENT_CAP (S4.3b) — usage.get shows a rowless org the cap it is enforced at; same optional GH
      // var as engine (unset → "" → uncapped). Kept identical across every worker that renders usage.
      "<FREE_EVENT_CAP>",
      "<BILLING_MODE>",
      // STRIPE_METER_EVENT_NAME (WS3) — the meter the tail-flush reports against; same optional GH var as
      // engine (unset → "" → the flush is dark). ids/names only, no price figure.
      "<STRIPE_METER_EVENT_NAME>",
      "webhook-payloads-dev",
    ],
    // HYPERDRIVE_BILLING (S4.5) — kept only when HYPERDRIVE_BILLING_ID is provisioned, else stripped.
    // HYPERDRIVE_ACTIVATION_REVIEWER (ADR-0127) — same keep-when-provisioned rule; pairs with the
    // INTERNAL_REVIEW_TOKEN secret above (both gated on HYPERDRIVE_ACTIVATION_REVIEWER_ID).
    optionalHyperdrives: ["HYPERDRIVE_BILLING_ID", "HYPERDRIVE_ACTIVATION_REVIEWER_ID"],
    // Service bindings to the engine's WorkerEntrypoints — deploy-injected (NOT committed), exactly like
    // mcp's AUTH_ISSUER: the engine entrypoints are already LIVE, so CF late-binds them fine; committing
    // them would block a cold deploy.
    //   * PROVIDER_SECRET_SEALER (ADR-0078/B0 #246) — endpoints.addProviderSecret seals via the engine
    //     (api never holds the KEK).
    //   * DELIVERY_DISPATCHER (ADR-0081, 1b PR1 #288) — events.replay {kind:"destination"} delivers via
    //     the engine (the single SSRF egress chokepoint; api never makes the outbound POST itself).
    services: [
      {
        binding: "PROVIDER_SECRET_SEALER",
        service: "webhook-engine",
        entrypoint: "ProviderSecretSealer",
      },
      {
        binding: "DELIVERY_DISPATCHER",
        service: "webhook-engine",
        entrypoint: "DeliveryDispatcher",
      },
      // INGEST_URL_REVEALER (S8-remainder / ADR-0101) — endpoints.revealIngestUrl unseals the always-shown
      // ingest URL via the engine's IngestUrlRevealer entrypoint (api never holds the KEK). The engine must
      // deploy with this entrypoint FIRST (same deploy, engine-before-api order) or CF late-binds.
      {
        binding: "INGEST_URL_REVEALER",
        service: "webhook-engine",
        entrypoint: "IngestUrlRevealer",
      },
      // PAYLOAD_READER (S5 Slice C2) — triggers.wait fetches the bounded inline event body via the engine's
      // PayloadReader entrypoint (this worker holds no R2 binding); org-scoped + size-capped.
      {
        binding: "PAYLOAD_READER",
        service: "webhook-engine",
        entrypoint: "PayloadReader",
      },
    ],
  },
  mcp: {
    domain: "mcp.webhook.co",
    // + MCP_SESSION_KEY (A8c): the mcp-specific session-binding HMAC key (not shared with engine/api).
    secrets: [...SHARED, "MCP_SESSION_KEY"],
    // KV_CONFIG (ADR-0076): bound into mcp ONLY to evict on the endpoints.delete/rotate tools — same
    // namespace as engine via the existing KV_CONFIG_ID repo var (no new var).
    placeholders: [
      "<HYPERDRIVE_AUTHN_ID>",
      "<HYPERDRIVE_TENANT_ID>",
      "<KV_AUTHZ_ID>",
      "<KV_CONFIG_ID>",
      // FREE_EVENT_CAP (S4.3b) — the usage.get tool shows a rowless org the cap it is enforced at; same
      // optional GH var as engine (unset → "" → uncapped). Identical across every worker rendering usage.
      "<FREE_EVENT_CAP>",
    ],
    // AUTH_ISSUER (A8) — the service binding to auth.'s IssuerIntrospect WorkerEntrypoint, so mcp validates
    // opaque OAuth provider tokens by introspection. Deploy-injected here (NOT committed) because of the
    // ordering: auth. must be LIVE first (it is now — apps/auth deployed), or CF late-binds and mcp fails to
    // start. Until this, a non-`whk_` token at mcp 500s (fail-closed); with it, introspection works.
    services: [
      { binding: "AUTH_ISSUER", service: "webhook-auth", entrypoint: "IssuerIntrospect" },
      // PROVIDER_SECRET_SEALER (ADR-0078/B0, D2) — seal via the engine's ProviderSecretSealer entrypoint
      // (the McpAgent never holds the KEK). Engine entrypoint LIVE from B0 #246; same late-bind safety.
      {
        binding: "PROVIDER_SECRET_SEALER",
        service: "webhook-engine",
        entrypoint: "ProviderSecretSealer",
      },
      // INGEST_URL_REVEALER (S8-remainder / ADR-0101) — the endpoints.revealIngestUrl tool unseals via the
      // engine's IngestUrlRevealer entrypoint (the McpAgent never holds the KEK); engine-before-mcp order.
      {
        binding: "INGEST_URL_REVEALER",
        service: "webhook-engine",
        entrypoint: "IngestUrlRevealer",
      },
      // PAYLOAD_READER (S5 Slice C2) — triggers.wait fetches the bounded inline event body via the engine's
      // PayloadReader entrypoint (this worker holds no R2 binding); org-scoped + size-capped.
      {
        binding: "PAYLOAD_READER",
        service: "webhook-engine",
        entrypoint: "PayloadReader",
      },
    ],
  },
  // The dashboard (app.webhook.co) — an OpenNext SSR Worker (main = .open-next/worker.js), deployed by
  // deploy-web.yml after `opennextjs-cloudflare build`. It reads the credential pepper + audit-chain key
  // (byte-identical to api/engine/mcp) and SESSION_TOKEN_SECRET (its own session-cookie HMAC key, web-only —
  // not in SHARED). Binds the same webhook_app Hyperdrive (HYPERDRIVE_TENANT), shared KV_AUTHZ, the engine's
  // KV_CONFIG (ingest-token cache, evict-only — the endpoint delete/rotate actions, ADR-0076/0077) + the
  // R2_PAYLOADS bucket (read-only, the event payload-inspect view). AUTH_BASE_URL isn't injected — env.ts
  // defaults it to https://auth.webhook.co in prod.
  web: {
    domain: "app.webhook.co",
    // + LISTEN_TICKET_KEY: mints the dashboard live-events listen ticket the engine verifies (byte-identical
    //   to the engine's binding). Web signs, engine verifies — the browser opens `/listen` with it.
    secrets: [
      "CREDENTIAL_PEPPER",
      "AUDIT_CHAIN_HMAC_KEY",
      "SESSION_TOKEN_SECRET",
      "LISTEN_TICKET_KEY",
      // RESEND_API_KEY — the invite email (Lane 2.5). The SAME store secret auth. already binds for the
      // magic link, so it is provisioned; binding it here cannot fail on a missing secret. If it were ever
      // absent, getResendApiKey() returns null and the invite falls back to the copy-link rather than
      // breaking.
      "RESEND_API_KEY",
      // STRIPE_SECRET_KEY (S4.4b) — the dashboard Checkout/Portal Stripe key. Bound only when billing is on.
      ...whenBilling(["STRIPE_SECRET_KEY"]),
    ],
    // + KV_CONFIG (the engine's ingest-token cache, same namespace by id) so the dashboard's endpoint
    // delete/rotate actions evict the old token (ADR-0076/0077); + R2_PAYLOADS (webhook-payloads-dev →
    // -prod) for the event payload-inspect view. Both reuse existing GH repo vars/buckets — no new infra.
    placeholders: [
      "<HYPERDRIVE_TENANT_ID>",
      "<KV_AUTHZ_ID>",
      "<KV_CONFIG_ID>",
      // FREE_EVENT_CAP (S4.3b) — the usage view shows a rowless org the cap it is enforced at; same optional
      // GH var as engine (unset → "" → uncapped). Identical across every worker rendering usage.
      "<FREE_EVENT_CAP>",
      "<ASYNC_ORG_DELETION>",
      "<BILLING_MODE>",
      "<STRIPE_PLANS>",
      "<STRIPE_PORTAL_CONFIGURATION_ID>",
      "webhook-payloads-dev",
      "webhook-avatars-dev",
    ],
    // AUTH_SESSION_EXCHANGE — the web→auth service binding to auth.'s SessionExchange WorkerEntrypoint, so the
    // app. session handoff redeems its single-use ticket over a private RPC instead of the public
    // POST /session/exchange route. Deploy-injected (NOT committed), exactly like mcp's AUTH_ISSUER: auth. must
    // be LIVE with the SessionExchange entrypoint first (it is — deployed in #200), or CF late-binds and web
    // fails to start. apps/web prefers this binding and falls back to the public fetch only when it's unbound,
    // so flipping it on is safe; the public route is retired in a follow-up once the binding is verified live.
    // PROVIDER_SECRET_SEALER — the web→engine service binding to the engine's seal-only ProviderSecretSealer
    // WorkerEntrypoint (mirrors api/mcp above), so the dashboard's replay-destination create/rotate actions
    // seal the minted `whsec_` signing secret via the engine (the KEK never enters the web worker; the binding
    // is write-only and cannot decrypt). Deploy-injected (NOT committed): the engine must be LIVE with the
    // ProviderSecretSealer entrypoint first (it is — used by api/mcp). apps/web fails closed when it's unbound
    // (a create/rotate errors rather than storing an unsigned secret), so flipping it on is safe.
    // DELIVERY_DISPATCHER — the web→engine service binding to the engine's DeliveryDispatcher WorkerEntrypoint
    // (mirrors api above), so the dashboard's replay-to-destination action delivers via the engine — the ONLY
    // guarded egress (connect-time DoH/CIDR SSRF guard + Standard-Webhooks signing happen there; the web worker
    // never fetches a destination itself). Deploy-injected (NOT committed): the engine must be LIVE with the
    // DeliveryDispatcher entrypoint first (it is — used by api). apps/web fails closed when it's unbound.
    services: [
      { binding: "AUTH_SESSION_EXCHANGE", service: "webhook-auth", entrypoint: "SessionExchange" },
      // AUTH_ACCOUNT_DELETER (slice 2.2) — the web→auth binding to auth.'s AccountDeleter entrypoint,
      // so account erasure deletes the identity as webhook_auth. auth. must be LIVE with the
      // AccountDeleter entrypoint first (same deploy-ordering note as SessionExchange); apps/web fails
      // closed (the action throws "temporarily unavailable") when it's unbound (dev / pre-provision).
      { binding: "AUTH_ACCOUNT_DELETER", service: "webhook-auth", entrypoint: "AccountDeleter" },
      // AUTH_CONNECTED_APPS — the web→auth binding to auth.'s ConnectedApps entrypoint, so the dashboard
      // lists/revokes a user's OAuth grants (which live in auth.'s OAUTH_KV, unreadable from web). auth. must
      // be LIVE with the ConnectedApps entrypoint first (same deploy-ordering note as SessionExchange);
      // apps/web renders "temporarily unavailable" (list) / errors (revoke) when it's unbound (dev/pre-provision).
      { binding: "AUTH_CONNECTED_APPS", service: "webhook-auth", entrypoint: "ConnectedApps" },
      // AUTH_ONBOARDING (Lane G) — the web→auth binding to auth.'s OnboardingProfile entrypoint, so the
      // onboarding gate reads/writes `firstName`/`lastName`/`onboardedAt`, which live on the `user` row in
      // auth.'s identity realm (webhook_auth-owned, unwritable from web's webhook_app role). auth. must be
      // LIVE with the OnboardingProfile entrypoint first (same deploy-ordering note as SessionExchange);
      // apps/web fails OPEN when it's unbound (dev / pre-provision): resolveOnboarding returns "don't show",
      // so the dashboard still renders — onboarding is a nicety, never a gate that can trap a user.
      { binding: "AUTH_ONBOARDING", service: "webhook-auth", entrypoint: "OnboardingProfile" },
      // AUTH_EMAIL_CHANGE (PR 8) — the web→auth binding to auth.'s EmailChanger entrypoint, so the email-change
      // ceremony writes the identity email + revokes sessions + purges verification as webhook_auth (the `user`
      // table is unwritable from web's webhook_app role). auth. must be LIVE with the EmailChanger entrypoint
      // first (same deploy-ordering note as SessionExchange); apps/web fails closed (the action returns
      // "temporarily unavailable") when it's unbound (dev / pre-provision).
      { binding: "AUTH_EMAIL_CHANGE", service: "webhook-auth", entrypoint: "EmailChanger" },
      // AUTH_LOGIN_METHODS (PR 8) — the web→auth binding to auth.'s LoginMethods entrypoint, so the security
      // page lists / unlinks a user's social sign-ins (rows in the identity `account` table). Same
      // deploy-ordering + fail-closed note as AUTH_EMAIL_CHANGE.
      { binding: "AUTH_LOGIN_METHODS", service: "webhook-auth", entrypoint: "LoginMethods" },
      {
        binding: "PROVIDER_SECRET_SEALER",
        service: "webhook-engine",
        entrypoint: "ProviderSecretSealer",
      },
      {
        binding: "DELIVERY_DISPATCHER",
        service: "webhook-engine",
        entrypoint: "DeliveryDispatcher",
      },
      // INGEST_URL_REVEALER (S8-remainder / ADR-0101) — the web→engine binding to the engine's
      // IngestUrlRevealer WorkerEntrypoint (mirrors api/mcp), so the endpoint-detail page shows the always-shown
      // ingest URL (the KEK stays in the engine; web passes identifiers, gets the URL). Deploy-injected (NOT
      // committed): the engine is LIVE with the entrypoint from slice 2a. apps/web degrades to the
      // rotate-to-reveal hint when it's unbound, so flipping it on is safe.
      {
        binding: "INGEST_URL_REVEALER",
        service: "webhook-engine",
        entrypoint: "IngestUrlRevealer",
      },
      // INGEST_CACHE_EVICTOR (WS3, the overage toggle) — the web→engine binding to the engine's
      // IngestCacheEvictor WorkerEntrypoint. The dashboard flips org_limits.pause_policy AND durably
      // reconciles ingest_paused in one DB tx (setOverageEnabled), then calls this so the engine evicts the
      // org's ingest-token entries from the KV cache it owns (picked up on the next cold miss instead of at
      // the TTL). Deploy-injected (NOT committed): the engine must be LIVE with the IngestCacheEvictor
      // entrypoint first (engine-before-web order). apps/web degrades to TTL-freshness (best-effort, logged)
      // when it's unbound — enforcement is already durable, so flipping it on is safe.
      {
        binding: "INGEST_CACHE_EVICTOR",
        service: "webhook-engine",
        entrypoint: "IngestCacheEvictor",
      },
    ],
  },
  // The OAuth issuer + Better Auth runtime (auth.webhook.co) — an OpenNext SSR Worker (main = src/worker.ts
  // wrapping .open-next/worker.js with @cloudflare/workers-oauth-provider), deployed by deploy-auth.yml after
  // `opennextjs-cloudflare build`. Binds its OWN OAUTH_KV/DEVICE_KV/RATELIMIT_KV + the shared KV_AUTHZ, and
  // three Hyperdrive clients (webhook_app TENANT, webhook_auth AUTH, webhook_authn AUTHN). Secrets: the
  // shared pepper + audit key, plus BETTER_AUTH_SECRET / CONSENT_TICKET_KEY / the Google+GitHub OAuth creds /
  // RESEND_API_KEY (the social-login + magic-link creds). No CURSOR_KEY (it serves no paginated reads).
  auth: {
    domain: "auth.webhook.co",
    secrets: [
      "BETTER_AUTH_SECRET",
      "CREDENTIAL_PEPPER",
      "AUDIT_CHAIN_HMAC_KEY",
      "CONSENT_TICKET_KEY",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "RESEND_API_KEY",
      // Cloudflare Turnstile siteverify secret — keys the captcha gate on the magic-link send.
      "TURNSTILE_SECRET_KEY",
    ],
    placeholders: [
      "<AUTH_OAUTH_KV_ID>",
      "<KV_AUTHZ_ID>",
      "<AUTH_DEVICE_KV_ID>",
      "<AUTH_RATELIMIT_KV_ID>",
      "<HYPERDRIVE_TENANT_ID>",
      "<HYPERDRIVE_AUTH_ID>",
      "<HYPERDRIVE_AUTHN_ID>",
      "<HYPERDRIVE_SWEEPER_ID>",
      "<HYPERDRIVE_NOTIFIER_ID>",
    ],
  },
};

// An OPTIONAL binding block in a committed wrangler.jsonc, wrapped in `// @gen-optional <ID>` … `// @gen-end
// <ID>` sentinels (each committed array element already carries its own trailing comma, so the block is
// self-contained). When the id env var is PROVISIONED → drop the two sentinel lines + substitute the id, so
// the binding ships. When UNSET → strip the whole block, so the worker deploys DARK without the binding
// (a Hyperdrive/secret binding can't be emitted with an empty id). Runs BEFORE the leftover/leak checks.
function applyOptionalBlock(app, txt, idEnv) {
  const startMark = `// @gen-optional ${idEnv}`;
  const endMark = `// @gen-end ${idEnv}`;
  const si = txt.indexOf(startMark);
  const ei = txt.indexOf(endMark);
  if (si === -1 || ei === -1 || ei < si)
    throw new Error(`${app}: optional sentinels for ${idEnv} not found/ordered`);
  const lineStart = txt.lastIndexOf("\n", si) + 1; // start of the `// @gen-optional` line
  const endNl = txt.indexOf("\n", ei);
  const lineEnd = endNl === -1 ? txt.length : endNl + 1; // through the end of the `// @gen-end` line
  if (process.env[idEnv]) {
    const inner = txt
      .slice(lineStart, lineEnd)
      .split("\n")
      .filter((l) => !l.includes("@gen-optional") && !l.includes("@gen-end"))
      .join("\n")
      .split(`<${idEnv}>`)
      .join(process.env[idEnv]);
    return txt.slice(0, lineStart) + inner + txt.slice(lineEnd);
  }
  return txt.slice(0, lineStart) + txt.slice(lineEnd); // strip the whole block (dark)
}

for (const [app, cfg] of Object.entries(APPS)) {
  const src = join(REPO, "apps", app, "wrangler.jsonc");
  let txt = readFileSync(src, "utf8");

  // 1) replace every expected placeholder/token; fail loudly if one is missing (drifted config).
  for (const ph of cfg.placeholders) {
    if (!txt.includes(ph))
      throw new Error(`${app}: token ${ph} not found in committed wrangler.jsonc`);
    txt = txt.split(ph).join(TOKEN[ph]);
  }
  // 1b) resolve optional bindings (keep-when-provisioned / strip-when-dark) before the leak checks.
  for (const idEnv of cfg.optionalHyperdrives ?? []) txt = applyOptionalBlock(app, txt, idEnv);
  const leftover = txt.match(/<[A-Z_]+_ID>/g);
  if (leftover) throw new Error(`${app}: unreplaced placeholders ${leftover.join(", ")}`);
  // Defense-in-depth beyond the `<..._ID>` regex: no TOKEN key may survive into the prod config. The
  // loop above replaces the ones we expect; this catches a token PRESENT in the committed wrangler.jsonc
  // but missing from cfg.placeholders (e.g. a newly-added `*-dev` bucket), which would otherwise ship a
  // prod config still pointing at a dev resource. Safe from false positives: no TOKEN key is a substring
  // of any replacement value or of the injected keys.
  const survived = Object.keys(TOKEN).filter((k) => txt.includes(k));
  if (survived.length)
    throw new Error(`${app}: tokens leaked unreplaced into prod config: ${survived.join(", ")}`);

  // 2) inject the per-environment top-level keys right after the opening brace (JSONC tolerates it).
  const inject = {
    account_id: ACCOUNT_ID,
    workers_dev: false,
    routes: [{ pattern: cfg.domain, custom_domain: true }],
    secrets_store_secrets: secretsBlock(cfg.secrets),
    // Service bindings (only mcp's AUTH_ISSUER today) — deploy-injected so the binding target Worker can be
    // brought live first (CF late-binds a referenced service; committing it would block a cold deploy).
    ...(cfg.services ? { services: cfg.services } : {}),
  };
  const block = Object.entries(inject)
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(",\n");
  const brace = txt.indexOf("{");
  txt = `${txt.slice(0, brace + 1)}\n${block},${txt.slice(brace + 1)}`;

  const out = join(REPO, "apps", app, "wrangler.prod.jsonc");
  writeFileSync(out, txt);
  console.log(`wrote ${out} (domain ${cfg.domain}, ${cfg.secrets.length} secrets)`);
}
