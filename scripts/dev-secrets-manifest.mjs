// The local-development secret surface, declared once.
//
// Why this file exists: `.dev.vars` is gitignored, there was no example of any kind, and the key
// names lived only in whichever uncommitted file the founder happened to have. A new engineer — or
// any external contributor, since this repo is Apache-2.0 and public — could not learn them without
// reading every app's env module. `docs/local-billing-sandbox.md` even asserted that
// `apps/api/.dev.vars` "already carries" its values, which is false for every clone.
//
// Three scopes, and the distinction is the whole point:
//
//   generated  — a random local value. No shared secret, nothing to distribute, nothing to leak.
//                Generated on your machine and never the same as any other machine's.
//   local      — a fixed non-secret literal (a URL, a mode flag). Safe to commit.
//   external   — needs a real third-party credential to exercise the feature. ALWAYS optional
//                locally: the app must degrade to a documented local behaviour without it. If a
//                feature cannot be exercised without an external credential, that is a parity gap
//                to fix in the code, not a value to hand out.
//
// `shared: true` means the value MUST be byte-identical across every app that reads it. This is not
// cosmetic: web mints a listen ticket with LISTEN_TICKET_KEY and engine verifies it, so a mismatch
// presents as a dead dashboard WebSocket with no configuration error anywhere. Before this file,
// LISTEN_TICKET_KEY was in apps/engine/.dev.vars and absent from apps/web/.dev.vars, so web silently
// signed with a hardcoded dev fallback.

/** 32 random bytes, base64. The format `resolveCredentialHasher` and the cursor/HMAC keys expect. */
export const GENERATED_BYTES = 32;

/**
 * @typedef {object} SecretSpec
 * @property {string} name
 * @property {"generated"|"local"|"external"} scope
 * @property {boolean} [shared]   value must match across apps
 * @property {string} [value]     for scope "local": the literal to write
 * @property {string} note        why it exists / what happens without it
 */

/** Secrets that must be identical everywhere they appear. Generated once per machine. */
export const SHARED = [
  {
    name: "CREDENTIAL_PEPPER",
    scope: "generated",
    shared: true,
    note: "HMAC pepper for API keys and ingest tokens. Read by api, engine, mcp, auth, web and packages/db — a mismatch makes a key minted by one surface unrecognisable to another.",
  },
  {
    name: "AUDIT_CHAIN_HMAC_KEY",
    scope: "generated",
    shared: true,
    note: "Hash-chain key for the tamper-evident audit log. Must match across every surface that appends or verifies.",
  },
  {
    name: "LISTEN_TICKET_KEY",
    scope: "generated",
    shared: true,
    note: "web MINTS the dashboard live-events ticket, engine VERIFIES it. A mismatch is a dead WebSocket with no config error — the exact bug this manifest exists to prevent.",
  },
  {
    name: "CURSOR_KEY",
    scope: "generated",
    shared: true,
    note: "HMAC key for keyset pagination cursors. Read by api, engine and mcp; a cursor issued by one must verify in another.",
  },
];

/** Per-app secrets. `shared` entries above are merged in for the apps that read them. */
export const APPS = {
  api: {
    shared: ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY", "CURSOR_KEY"],
    own: [
      {
        name: "BILLING_MODE",
        scope: "local",
        value: "test",
        note: "off | test | live. `test` locally so the Stripe sandbox path is exercised; the client asserts the key prefix matches the mode.",
      },
      {
        name: "STRIPE_SECRET_KEY",
        scope: "external",
        note: "Stripe TEST-mode key (sk_test_...). Without it billing is dark — every Stripe path no-ops rather than failing. See docs/local-billing-sandbox.md.",
      },
      {
        name: "STRIPE_WEBHOOK_SIGNING_SECRET",
        scope: "external",
        note: "Self-serve: `stripe listen --print-secret` prints your own. Without it the receiver returns 503 before reading the body.",
      },
      {
        name: "STRIPE_METER_EVENT_NAME",
        scope: "local",
        value: "webhook_events",
        note: "Meter event name. Empty means the metering flush is dark.",
      },
    ],
  },
  engine: {
    shared: ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY", "CURSOR_KEY", "LISTEN_TICKET_KEY"],
    own: [
      {
        name: "KMS_MODE",
        scope: "local",
        value: "local",
        note: "Selects the hermetic dev KEK custodian instead of AWS KMS. Without it, creating an endpoint needs real AWS IAM credentials. Lives ONLY here — .dev.vars is never sent by `wrangler deploy`, kmsProviderFromEnv refuses it whenever AWS KMS config is bound, and scripts/kms-mode-guard.mjs keeps it out of every committed Worker config.",
      },
      {
        name: "LOCAL_KEK",
        scope: "generated",
        note: "The dev KEK, 32 random bytes. Stable across restarts so endpoints sealed before a restart stay openable — LocalKmsProvider.generate() would mint a fresh key each process and orphan them.",
      },
      {
        name: "FREE_EVENT_CAP",
        scope: "local",
        value: "5000",
        note: "MATCHES PRODUCTION. Unset parses to uncapped, so local silently skipped the cap logic that prod enforces.",
      },
      {
        name: "BILLING_MODE",
        scope: "local",
        value: "test",
        note: "See api.",
      },
      {
        name: "DASHBOARD_ORIGIN",
        scope: "local",
        value: "http://localhost:3000",
        note: "Origin allowed to open the listen WebSocket. Appears in NO wrangler config and NO .dev.vars — pure tribal knowledge until now. Unset, only https://app.webhook.co is allowed, so the local dashboard's live events are rejected with no hint.",
      },
    ],
  },
  web: {
    shared: ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY", "LISTEN_TICKET_KEY"],
    own: [
      {
        name: "AUTH_BASE_URL",
        scope: "local",
        value: "http://localhost:3001",
        note: "Where web sends you to sign in. apps/web/src/server/env.ts:35 already assumes :3001 — but nothing binds auth to that port, so it worked only by accident of start order.",
      },
      {
        name: "SESSION_TOKEN_SECRET",
        scope: "generated",
        note: "Signs the dashboard session cookie. web falls back to a hardcoded dev value when unset, which is why a local session silently works — set it explicitly so local matches prod shape.",
      },
      {
        name: "BILLING_MODE",
        scope: "local",
        value: "test",
        note: "See api.",
      },
      {
        name: "EMAIL_MODE",
        scope: "local",
        value: "log",
        note: "Invite emails print to the console (link included) instead of being sent. Without it, an unconfigured Resend key silently falls back to the copy-link path, so the invite EMAIL path is never exercised locally.",
      },
      {
        name: "STRIPE_SECRET_KEY",
        scope: "external",
        note: "See api. Without it the plan picker does not render.",
      },
    ],
  },
  auth: {
    shared: ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY"],
    own: [
      {
        name: "AUTH_BASE_URL",
        scope: "local",
        value: "http://localhost:3001",
        note: "apps/auth/src/runtime/env.ts:37 — 'Set in dev (.dev.vars) so the handoff redirects to localhost, not prod.' Unset, the auth->app handoff redirects to PRODUCTION.",
      },
      {
        name: "APP_BASE_URL",
        scope: "local",
        value: "http://localhost:3000",
        note: "Where auth sends you after login. Defaults to the prod dashboard host, so locally you would land on app.webhook.co.",
      },
      {
        name: "BETTER_AUTH_SECRET",
        scope: "generated",
        note: "Better Auth signing secret. In auth's REQUIRED_SECRETS — the app throws at the request boundary without it.",
      },
      {
        name: "CONSENT_TICKET_KEY",
        scope: "generated",
        note: "HMAC key for the OAuth consent ticket.",
      },
      {
        name: "OAUTH_MODE",
        scope: "local",
        value: "optional",
        note: "Social login is optional locally: providers without BOTH halves configured are simply not wired, and you sign in by magic link. Refused outright if an OAuth secret is a Secrets Store binding (the prod shape).",
      },
      {
        name: "EMAIL_MODE",
        scope: "local",
        value: "log",
        note: "Transactional mail is PRINTED to the console instead of sent — this is how you get your magic-link URL locally. Refused outright if RESEND_API_KEY is a Secrets Store binding (the prod shape).",
      },
      {
        name: "GOOGLE_CLIENT_ID",
        scope: "external",
        note: "Google OAuth dev app with an http://localhost:3001 callback. OPTIONAL now that OAUTH_MODE=optional is set: leave it blank and the Google button is simply absent.",
      },
      { name: "GOOGLE_CLIENT_SECRET", scope: "external", note: "Pairs with GOOGLE_CLIENT_ID." },
      {
        name: "GITHUB_CLIENT_ID",
        scope: "external",
        note: "GitHub OAuth dev app. Optional — see GOOGLE_CLIENT_ID.",
      },
      { name: "GITHUB_CLIENT_SECRET", scope: "external", note: "Pairs with GITHUB_CLIENT_ID." },
      {
        name: "RESEND_API_KEY",
        scope: "external",
        note: "Transactional email. OPTIONAL now that EMAIL_MODE=log is set — leave it blank and mail prints to the console. Set it only to exercise real delivery.",
      },
      {
        name: "TURNSTILE_SECRET_KEY",
        scope: "external",
        note: "Leave it UNSET locally. Unset means the captcha plugin is not wired, and the login widget renders Cloudflare's always-pass test sitekey on localhost. Wiring the test SECRET would break local login: siteverify returns hostname example.com, which the plugin's allowedHostnames pin rejects.",
      },
    ],
  },
  mcp: {
    shared: ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY", "CURSOR_KEY"],
    own: [
      {
        name: "MCP_SESSION_KEY",
        scope: "generated",
        note: "Signs the principal-bound Mcp-Session-Id. No dev fallback — missing it surfaces as an anonymous TypeError from readSecretBinding, not a named error.",
      },
    ],
  },
};

/** Every app that gets a generated `.dev.vars`. */
export const APP_NAMES = Object.freeze(Object.keys(APPS));

/**
 * The full ordered spec list for one app: its shared secrets first, then its own.
 * @param {string} app
 * @returns {SecretSpec[]}
 */
export function specsFor(app) {
  const entry = APPS[app];
  if (!entry) throw new Error(`dev-secrets: unknown app ${JSON.stringify(app)}`);
  const shared = entry.shared.map((name) => {
    const spec = SHARED.find((s) => s.name === name);
    if (!spec) throw new Error(`dev-secrets: ${app} names unknown shared secret ${name}`);
    return spec;
  });
  return [...shared, ...entry.own];
}

/** Names that must hold the same value in every app that declares them. */
export function sharedNames() {
  return SHARED.map((s) => s.name);
}
