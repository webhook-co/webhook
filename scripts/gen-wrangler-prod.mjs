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
      "webhook-payloads-dev",
    ],
  },
  mcp: {
    domain: "mcp.webhook.co",
    // + MCP_SESSION_KEY (A8c): the mcp-specific session-binding HMAC key (not shared with engine/api).
    secrets: [...SHARED, "MCP_SESSION_KEY"],
    placeholders: ["<HYPERDRIVE_AUTHN_ID>", "<HYPERDRIVE_TENANT_ID>", "<KV_AUTHZ_ID>"],
    // AUTH_ISSUER (A8) — the service binding to auth.'s IssuerIntrospect WorkerEntrypoint, so mcp validates
    // opaque OAuth provider tokens by introspection. Deploy-injected here (NOT committed) because of the
    // ordering: auth. must be LIVE first (it is now — apps/auth deployed), or CF late-binds and mcp fails to
    // start. Until this, a non-`whk_` token at mcp 500s (fail-closed); with it, introspection works.
    services: [{ binding: "AUTH_ISSUER", service: "webhook-auth", entrypoint: "IssuerIntrospect" }],
  },
  // The dashboard (app.webhook.co) — an OpenNext SSR Worker (main = .open-next/worker.js), deployed by
  // deploy-web.yml after `opennextjs-cloudflare build`. It reads the credential pepper + audit-chain key
  // (byte-identical to api/engine/mcp) and SESSION_TOKEN_SECRET (its own session-cookie HMAC key, web-only —
  // not in SHARED). Binds the SAME webhook_app Hyperdrive (HYPERDRIVE_TENANT) + shared KV_AUTHZ the wedge
  // uses. AUTH_BASE_URL isn't injected — env.ts defaults it to https://auth.webhook.co in prod.
  web: {
    domain: "app.webhook.co",
    secrets: ["CREDENTIAL_PEPPER", "AUDIT_CHAIN_HMAC_KEY", "SESSION_TOKEN_SECRET"],
    placeholders: ["<HYPERDRIVE_TENANT_ID>", "<KV_AUTHZ_ID>"],
    // NOTE: the AUTH_SESSION_EXCHANGE web→auth service binding (entrypoint "SessionExchange") is intentionally
    // NOT injected yet — this PR ships the binding-AWARE code inert (apps/web falls back to the public fetch
    // when the binding is unbound, so there's zero behavior change + zero deploy-ordering risk). ACTIVATION is
    // a deferred follow-up: add `services: [{ binding: "AUTH_SESSION_EXCHANGE", service: "webhook-auth",
    // entrypoint: "SessionExchange" }]` here ONLY AFTER auth.'s SessionExchange entrypoint is confirmed LIVE
    // (this PR's deploy), then deploy web + founder e2e the login (the OpenNext→WorkerEntrypoint RPC is
    // deploy:dry-verified but not yet proven in a live browser login).
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
