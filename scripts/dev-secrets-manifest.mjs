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
 * @typedef {object} RelaxingFlag
 * @property {string} name   the hermetic mode flag that makes this secret optional
 * @property {string} value  the value that flag must hold
 */

/**
 * @typedef {object} SecretSpec
 * @property {string} name
 * @property {"generated"|"local"|"external"} scope
 * @property {boolean} [shared]   value must match across apps
 * @property {string} [value]     for scope "local": the literal to write
 * @property {boolean} [parityRequired]  absent ⇒ local silently does LESS than prod (see below)
 * @property {RelaxingFlag} [relaxedBy]  the explicit opt-out that makes `parityRequired` acceptable
 * @property {string} note        why it exists / what happens without it
 */

// `parityRequired` is the machine-readable half of the "REQUIRED for prod parity" notes below, and it
// exists because prose cannot fail a build. Without it the notes were advisory: a clone with no
// `.dev.vars` produced a login page that rendered perfectly and simply offered fewer ways in, because
// the page derives its buttons from which OAuth secrets are PRESENT. Nothing errored, so nothing said
// so — the exact silent-degradation this repo's fence pattern is supposed to forbid ("flags are
// EXPLICIT, never inferred from a missing secret").
//
// `relaxedBy` names the explicit opt-out. An external contributor with no credentials sets the flag and
// is waved through; everyone else gets a hard failure naming what is missing. The flag is the
// acknowledgement — the difference between choosing a degraded local stack and not noticing you have one.
//
// Enforced by `scripts/dev-preflight.mjs`, which `pnpm dev` runs before starting anything.

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
        name: "INGEST_BASE_URL",
        scope: "local",
        value: "http://localhost:8787",
        note: "The ingest apex the endpoints.create response builds its one-time URL from. The committed wrangler var is the PROD apex (https://wbhk.my), so without this override a locally-created endpoint hands you a URL that points at production — which you cannot receive on.",
      },
      {
        name: "FREE_EVENT_CAP",
        scope: "local",
        value: "5000",
        note: 'Free-tier cap, matching the canonical plans catalog ("5,000 events, once"). The committed var is the deploy-time placeholder <FREE_EVENT_CAP>, and parseFreeEventCap fail-safes anything non-numeric to null = NO CAP — so locally the cap silently does not exist.',
      },
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
        note: "⚠️ TWO different values exist. Local delivery is `stripe listen`, which mints its OWN secret per machine — run `stripe listen --print-secret` and use THAT. The team's `whsec_…` belongs to the REGISTERED endpoint, which POSTs to a public URL and can never reach localhost; it looks right and fails as `400 invalid signature`. Without any value the receiver returns 503 before reading the body.",
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
        name: "ORPHAN_SWEEP_DELETE",
        scope: "local",
        value: "true",
        note: 'Enables the orphan-sweep DELETE rather than count-only, matching prod. The committed var is the placeholder <ORPHAN_SWEEP_DELETE> and the check is === "true", so locally the sweep only ever counts — you can never see it actually delete.',
      },
      {
        name: "STRIPE_METER_EVENT_NAME",
        scope: "external",
        note: "Stripe billing-meter event name from your sandbox. Leave blank unless exercising metering; the meter-reporter cron no-ops without it.",
      },
      {
        name: "STRIPE_METER_ID",
        scope: "external",
        note: "Stripe billing-meter id from your sandbox. Pairs with STRIPE_METER_EVENT_NAME.",
      },
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
        name: "INGEST_BASE_URL",
        scope: "local",
        value: "http://localhost:8787",
        note: "See api. The dashboard's create/rotate actions build the one-time ingest URL from this.",
      },
      {
        name: "FREE_EVENT_CAP",
        scope: "local",
        value: "5000",
        note: "See api.",
      },
      {
        name: "ASYNC_ORG_DELETION",
        scope: "local",
        value: "true",
        note: 'Routes org deletion through the async reaper, which is what production does (#665). The committed var is the placeholder <ASYNC_ORG_DELETION>, and the check is === "true", so locally you exercise the SYNC path — a different code path from the one that runs in prod.',
      },
      {
        name: "STRIPE_PLANS",
        scope: "external",
        note: "Stripe price ids per plan. Needs a Stripe sandbox; leave blank and the plan picker does not render. Account identifiers, so never committed.",
      },
      {
        name: "STRIPE_PORTAL_CONFIGURATION_ID",
        scope: "external",
        note: "Billing Portal configuration id from your Stripe sandbox. Leave blank unless you are exercising the portal.",
      },
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
        scope: "external",
        note: 'LEAVE BLANK so invite mail really sends, exactly as in prod. Set it to "log" only if you have no Resend key; invites then print to the console with their link.',
      },
      {
        name: "RESEND_API_KEY",
        scope: "external",
        note: "REQUIRED for prod parity — apps/web sends the INVITE email and reads this via getResendApiKey(). It was missing from this manifest entirely, so invite mail could never send locally and silently fell back to the copy-link path. Same key as prod and as apps/auth.",
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
        scope: "external",
        note: 'LEAVE BLANK. Local must match prod, so real Google/GitHub OAuth is the default and the buttons work exactly as they do in production. Set it to "optional" ONLY if you have no OAuth credentials at all (an external contributor) — that drops unconfigured providers and leaves magic link as the way in. See docs/local-parity.md.',
      },
      {
        name: "EMAIL_MODE",
        scope: "external",
        note: 'LEAVE BLANK. Local must match prod, so mail really sends via Resend using the team key. Set it to "log" ONLY if you have no Resend key — magic links then print to the console instead. See docs/local-parity.md.',
      },
      {
        name: "GOOGLE_CLIENT_ID",
        scope: "external",
        parityRequired: true,
        relaxedBy: { name: "OAUTH_MODE", value: "optional" },
        note: "REQUIRED for prod parity. The SAME Google OAuth app prod uses — its callback list already includes http://localhost:3001. The team value is in the shared credential store; ask rather than inventing a substitute.",
      },
      {
        name: "GOOGLE_CLIENT_SECRET",
        scope: "external",
        parityRequired: true,
        relaxedBy: { name: "OAUTH_MODE", value: "optional" },
        note: "Pairs with GOOGLE_CLIENT_ID.",
      },
      {
        name: "GITHUB_CLIENT_ID",
        scope: "external",
        parityRequired: true,
        relaxedBy: { name: "OAUTH_MODE", value: "optional" },
        note: "REQUIRED for prod parity. A SEPARATE GitHub OAuth app from prod's (GitHub allows one callback URL per app, so dev needs its own with http://localhost:3001/api/auth/callback/github). The team value is in the shared credential store.",
      },
      {
        name: "GITHUB_CLIENT_SECRET",
        scope: "external",
        parityRequired: true,
        relaxedBy: { name: "OAUTH_MODE", value: "optional" },
        note: "Pairs with GITHUB_CLIENT_ID.",
      },
      {
        name: "RESEND_API_KEY",
        scope: "external",
        parityRequired: true,
        relaxedBy: { name: "EMAIL_MODE", value: "log" },
        note: "REQUIRED for prod parity — the same Resend key prod uses, so local really sends. Only if you cannot have it, set EMAIL_MODE=log and mail prints to the console instead.",
      },
      {
        name: "TURNSTILE_SECRET_KEY",
        scope: "external",
        parityRequired: true,
        relaxedBy: { name: "EMAIL_MODE", value: "log" },
        note: "REQUIRED for prod parity, and REQUIRED whenever mail really sends (readAuthEnv refuses to boot otherwise) — the captcha gate is what protects the public magic-link endpoint from being used to send mail. Use the SAME widget prod uses: its Cloudflare domain list already includes localhost and 127.0.0.1, so the real sitekey solves locally and the real secret verifies it. The team value is in the shared credential store. Only if you cannot have it, set EMAIL_MODE=log — then no mail is sent and the gate is not needed.",
      },
    ],
  },
  mcp: {
    shared: ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY", "CURSOR_KEY"],
    own: [
      {
        name: "INGEST_BASE_URL",
        scope: "local",
        value: "http://localhost:8787",
        note: "See api. Must match api's value and the local engine's port, or the MCP tool hands out a URL nothing is listening on.",
      },
      {
        name: "FREE_EVENT_CAP",
        scope: "local",
        value: "5000",
        note: "See api.",
      },
      {
        name: "OPENAI_APPS_CHALLENGE_TOKEN",
        scope: "local",
        value: "local-openai-apps-challenge-token",
        note: "The plugin-directory domain-verification token served at /.well-known/openai-apps-challenge (ADR-0132). A local value so the route is EXERCISABLE locally rather than dark — curl it and you should get exactly this string back. The committed var is the deploy-time placeholder <OPENAI_APPS_CHALLENGE_TOKEN>, which is non-empty, so without a local override the endpoint would have served the literal placeholder as the token; the handler now rejects any /^<[A-Z0-9_]+>$/ value as well.",
      },
      {
        name: "MCP_SESSION_KEY",
        scope: "generated",
        note: "Signs the principal-bound Mcp-Session-Id. No dev fallback — missing it surfaces as an anonymous TypeError from readSecretBinding, not a named error.",
      },
    ],
  },

  // --- Apps that boot under `pnpm dev` but were absent from this manifest entirely ----------------
  // Eleven apps run; five were declared. The other six were not "covered with nothing to declare", they
  // were unconsidered — so `pnpm dev:secrets` never wrote them a file and preflight never checked one,
  // while printing a green "secrets present" line. dmarc proved the cost: it reads RESEND_API_KEY and
  // `pnpm cron dmarc` failed on a Resend 401. Every runnable app now appears here, and one that genuinely
  // needs nothing says so with an empty list — a decision, rather than an omission that looks identical.

  dmarc: {
    // Sends the DMARC aggregate-report alert. Both values are `wrangler secret put` in production.
    shared: [],
    own: [
      {
        name: "RESEND_API_KEY",
        scope: "external",
        parityRequired: true,
        relaxedBy: { name: "EMAIL_MODE", value: "log" },
        // Declared per-app rather than in SHARED because SHARED means "generated once per machine and
        // byte-identical everywhere"; this is a third-party credential. The vault's conflict check still
        // holds it to one value across apps, and NOT_SHAREABLE keeps it out of the vault itself.
        note: "REQUIRED for prod parity — the DMARC aggregate-report alert sends through Resend. Without it `pnpm cron dmarc` fails with a Resend 401, which is how this app's total absence from the manifest was found.",
      },
      {
        name: "EMAIL_MODE",
        // `external` rather than `local` for the same reason auth's is: requiredSpecs() treats every
        // non-external spec as mandatory, so a `local` flag whose correct value is BLANK would fail
        // preflight for everyone. A mode flag is optional by construction — that is what makes it an
        // opt-out rather than a setting.
        scope: "external",
        note: 'LEAVE BLANK so the DMARC alert really sends, exactly as in prod. Set it to "log" only if you have no Resend key; the alert then prints to the console and the rest of the cron still runs.',
      },
      {
        name: "ALERT_TO",
        scope: "local",
        value: "dev@localhost",
        note: "Where the DMARC alert is addressed. A local literal so `pnpm cron dmarc` exercises the real send path without mailing anyone real — change it if you want to receive one.",
      },
    ],
  },

  health: {
    // The heartbeat/canary surface. In production these are Secrets Store bindings; locally they are
    // plain strings, which is the same code path — readSecretBinding accepts either.
    shared: [],
    own: [
      {
        name: "HEARTBEAT_TOKEN",
        scope: "generated",
        note: "Authenticates the heartbeat POST. Generated per machine: it is a shared secret with the caller, and locally you are both ends of it.",
      },
    ],
  },

  // --- Considered, needs nothing ------------------------------------------------------------------
  // Verified by reading each Env interface / `env.` usage, not assumed. If one of these grows a variable,
  // the empty list is the thing that should look wrong in review.

  // Bindings only (ASSETS, WWW_ANALYTICS) — no vars, no secrets.
  www: { shared: [], own: [] },

  // Every var it reads (TURNSTILE_MODE, PLAY_TTL_MS, PLAY_MAX_ACTIVE, PLAY_MAX_PER_IP) is supplied by its
  // committed wrangler `vars`. TURNSTILE_SECRET_KEY is optional and only consulted when the mode is "on",
  // which locally it is not — see docs/local-parity.md, that gap is recorded rather than filled here.
  play: { shared: [], own: [] },

  // No Env interface and no `env.` reads.
  get: { shared: [], own: [] },

  // One Analytics Engine binding (TELEMETRY), no vars.
  telemetry: { shared: [], own: [] },
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
