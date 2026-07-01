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

// placeholder/literal token -> real value (resource ids from the env; bucket dev -> prod).
const TOKEN = {
  "<HYPERDRIVE_TENANT_ID>": reqEnv("HYPERDRIVE_TENANT_ID"),
  "<HYPERDRIVE_CACHED_ID>": reqEnv("HYPERDRIVE_CACHED_ID"),
  "<HYPERDRIVE_ANCHOR_ID>": reqEnv("HYPERDRIVE_ANCHOR_ID"),
  // The delivery reconciler's webhook_reconciler Hyperdrive (S3 Slice 3 PR3c-2) — bound to a least-privilege,
  // SELECT-only cross-org Neon role. The operator provisions the role + Hyperdrive and sets the
  // HYPERDRIVE_RECONCILER_ID GH repo var; the deploy workflow must provide it like every other id here.
  "<HYPERDRIVE_RECONCILER_ID>": reqEnv("HYPERDRIVE_RECONCILER_ID"),
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
  "webhook-payloads-dev": "webhook-payloads-prod",
  "webhook-audit-anchors-dev": "webhook-audit-anchors-prod",
};

const SHARED = ["CREDENTIAL_PEPPER", "CURSOR_KEY", "AUDIT_CHAIN_HMAC_KEY"];
const secretsBlock = (names) => names.map((n) => ({ binding: n, store_id: STORE, secret_name: n }));

const APPS = {
  engine: {
    domain: "wbhk.my",
    secrets: [...SHARED, "KMS_KEY_ARN", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    placeholders: [
      "<HYPERDRIVE_TENANT_ID>",
      "<HYPERDRIVE_CACHED_ID>",
      "<HYPERDRIVE_ANCHOR_ID>",
      "<HYPERDRIVE_RECONCILER_ID>",
      "<HYPERDRIVE_AUTHN_ID>",
      "<HYPERDRIVE_INGEST_ID>",
      "<KV_CONFIG_ID>",
      "<KV_AUTHZ_ID>",
      "webhook-payloads-dev",
      "webhook-audit-anchors-dev",
    ],
  },
  api: {
    domain: "api.webhook.co",
    secrets: SHARED,
    placeholders: [
      "<HYPERDRIVE_AUTHN_ID>",
      "<HYPERDRIVE_TENANT_ID>",
      "<KV_AUTHZ_ID>",
      // KV_CONFIG: the engine's ingest cache, bound into api ONLY to evict on endpoints.delete/rotate
      // (ADR-0076). Reuses the existing KV_CONFIG_ID GH repo var (no new var) — same namespace as engine.
      "<KV_CONFIG_ID>",
      "webhook-payloads-dev",
    ],
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
    secrets: ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY", "SESSION_TOKEN_SECRET"],
    // + KV_CONFIG (the engine's ingest-token cache, same namespace by id) so the dashboard's endpoint
    // delete/rotate actions evict the old token (ADR-0076/0077); + R2_PAYLOADS (webhook-payloads-dev →
    // -prod) for the event payload-inspect view. Both reuse existing GH repo vars/buckets — no new infra.
    placeholders: [
      "<HYPERDRIVE_TENANT_ID>",
      "<KV_AUTHZ_ID>",
      "<KV_CONFIG_ID>",
      "webhook-payloads-dev",
    ],
    // AUTH_SESSION_EXCHANGE — the web→auth service binding to auth.'s SessionExchange WorkerEntrypoint, so the
    // app. session handoff redeems its single-use ticket over a private RPC instead of the public
    // POST /session/exchange route. Deploy-injected (NOT committed), exactly like mcp's AUTH_ISSUER: auth. must
    // be LIVE with the SessionExchange entrypoint first (it is — deployed in #200), or CF late-binds and web
    // fails to start. apps/web prefers this binding and falls back to the public fetch only when it's unbound,
    // so flipping it on is safe; the public route is retired in a follow-up once the binding is verified live.
    services: [
      { binding: "AUTH_SESSION_EXCHANGE", service: "webhook-auth", entrypoint: "SessionExchange" },
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
    ],
  },
};

for (const [app, cfg] of Object.entries(APPS)) {
  const src = join(REPO, "apps", app, "wrangler.jsonc");
  let txt = readFileSync(src, "utf8");

  // 1) replace every expected placeholder/token; fail loudly if one is missing (drifted config).
  for (const ph of cfg.placeholders) {
    if (!txt.includes(ph))
      throw new Error(`${app}: token ${ph} not found in committed wrangler.jsonc`);
    txt = txt.split(ph).join(TOKEN[ph]);
  }
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
