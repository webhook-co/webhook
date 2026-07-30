// The cross-Worker service bindings, declared ONCE.
//
// These live here rather than inside the prod generator because two consumers need the same list and a
// second hand-kept copy would drift: `gen-wrangler-prod.mjs` injects them into the deploy config, and the
// local dev overlay needs the identical set for `wrangler dev` to resolve a binding across sessions.
//
// They are NOT committed into `apps/<app>/wrangler.jsonc` (with two historical exceptions, which the prod
// generator merges rather than duplicates). Cloudflare rejects an UPLOAD whose service binding names a
// Worker that does not exist yet, so committing them all would block a cold deploy: a fresh environment
// brings the Workers up one at a time, and `webhook-web` could not deploy before `webhook-auth` existed.
//
// `binding` is the name the calling Worker reads off `env`; `service` is the target Worker's config `name`;
// `entrypoint` is the exported WorkerEntrypoint class on that Worker's `main`. All three must match exactly
// — a wrong entrypoint fails only at call time, never at deploy.

/**
 * @typedef {object} ServiceBinding
 * @property {string} binding
 * @property {string} service
 * @property {string} entrypoint
 */

/** @type {Readonly<Record<string, readonly ServiceBinding[]>>} */
export const SERVICE_BINDINGS = Object.freeze({
  api: [
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

  mcp: [
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

  web: [
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
});

/** The bindings for one app, or an empty list when it calls no other Worker. */
export function serviceBindingsFor(app) {
  return SERVICE_BINDINGS[app] ?? [];
}

/**
 * Find the committed `services` array in a JSONC config.
 *
 * Returns its parsed entries plus the text with that block removed, so the generator can emit exactly ONE
 * `services` key. Brace-counted rather than regex-matched: the array contains nested objects, and a lazy
 * regex would stop at the first `]` inside one.
 *
 * @returns {{entries: {binding: string, service: string, entrypoint?: string}[], without: string}}
 */
export function extractServices(txt) {
  const at = txt.search(/"services"\s*:\s*\[/);
  if (at < 0) return { entries: [], without: txt };
  const open = txt.indexOf("[", at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < txt.length; i++) {
    if (txt[i] === "[") depth++;
    else if (txt[i] === "]" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) throw new Error("unterminated services array in committed wrangler.jsonc");
  const body = txt
    .slice(open, close + 1)
    .replace(/\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  let entries;
  try {
    entries = JSON.parse(body);
  } catch (err) {
    throw new Error(`could not parse the committed services block: ${err.message}`, { cause: err });
  }
  let end = close + 1;
  while (end < txt.length && /[\s,]/.test(txt[end])) {
    const wasComma = txt[end] === ",";
    end++;
    if (wasComma) break;
  }
  return { entries, without: txt.slice(0, at) + txt.slice(end) };
}

/**
 * Union two service-binding lists by `binding` name. The injected entry wins a conflict — it is the deploy's
 * own view of the target Worker — but a committed binding the injected table does not mention is KEPT, so
 * merging can never silently drop one.
 */
export function mergeServices(injected, committed) {
  const byBinding = new Map();
  for (const e of committed) byBinding.set(e.binding, e);
  for (const e of injected) byBinding.set(e.binding, e);
  return [...byBinding.values()];
}
