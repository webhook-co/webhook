// The canonical local port for every app — one place, so nothing has to be discovered by trial.
//
// Before this, THREE apps had a `dev` script and none of them pinned a port. `next dev` takes 3000 and then
// walks upward when it is taken, so which app landed where depended on the order you happened to start them.
// Meanwhile apps/web hard-codes auth at :3001 (`DEV_AUTH_BASE_URL`) and nothing bound auth there — it worked
// by accident of start order, and broke silently when it didn't.
//
// The eight Worker apps had no `dev` script at all, so there was no supported way to run the engine locally.
// That is why an ingest URL had nothing to hit.
//
// ── The auth entry is not a port choice, it is a correctness one ──────────────────────────────────────
//
// apps/auth's wrangler config sets `"main": "src/worker.ts"` — a custom Worker that wraps the OpenNext
// handler with the OAuth provider. `next dev` does NOT run that worker. So under `next dev` the entire
// issuer surface — /session/handoff, /session/exchange, /token, /authorize — SIMPLY DOES NOT EXIST, and
// the auth→app handoff cannot complete locally. The failure looks like a redirect loop back to /login,
// which is indistinguishable from a dozen other causes.
//
// So auth's default dev command is the OpenNext preview, which runs the real worker. It costs a build step,
// and that is the honest trade: a fast dev server that silently omits half the surface is worse than a
// slower one that doesn't. `pnpm --filter auth dev:fast` is the opt-in fast path for pure page work; it
// runs `next dev` and therefore has NO issuer routes, which is fine as long as you chose it knowingly.

/**
 * @typedef {object} DevApp
 * @property {number} port          The pinned local port.
 * @property {"next" | "worker" | "opennext"} kind  Which dev server runs it.
 * @property {string} [note]        Why this app is special, when it is.
 */

/**
 * Every app that can run locally, and where.
 *
 * `docs` is deliberately absent: it is Mintlify-hosted, has no wrangler config and no next config, and
 * there is no local server of ours to start. Its absence is a fact about the app, not an oversight — the
 * guard asserts exactly that rather than letting a missing entry pass unnoticed.
 */
export const DEV_APPS = Object.freeze({
  // The three browser surfaces. 3000/3001 are load-bearing: apps/web defaults AUTH_BASE_URL to :3001 and
  // APP_BASE_URL to :3000, and the dev-secrets manifest writes the same pair.
  // web's wrangler `main` is the GENERATED `.open-next/worker.js` — no hand-written worker code — so
  // `next dev` is a faithful local stand-in and gets the fast loop.
  web: { port: 3000, kind: "next" },
  auth: {
    port: 3001,
    kind: "opennext",
    note: "MUST run the custom worker (src/worker.ts) — `next dev` omits the whole issuer surface.",
  },
  www: {
    port: 3002,
    kind: "next",
    note: "`next dev` omits its custom worker: the cookieless page-view write and the MTA-STS route. Both are minor and neither blocks content work, so www keeps the fast loop — but that IS a parity gap and belongs in the ledger.",
  },

  // The Workers. The engine is FIRST and its number is load-bearing: INGEST_BASE_URL points at it, so a
  // locally-created endpoint's ingest URL is only reachable if the engine is actually on this port.
  engine: {
    port: 8787,
    kind: "worker",
    note: "INGEST_BASE_URL points here. Changing this breaks ingest.",
  },
  api: { port: 8788, kind: "worker" },
  mcp: { port: 8789, kind: "worker" },
  play: { port: 8790, kind: "worker" },
  get: { port: 8791, kind: "worker" },
  health: { port: 8792, kind: "worker" },
  dmarc: { port: 8793, kind: "worker" },
  telemetry: { port: 8794, kind: "worker" },
});

/** Apps with no local server of ours. Listed so "missing" and "deliberately absent" stay distinguishable. */
export const NO_LOCAL_SERVER = Object.freeze(["docs"]);

/** The ingest apex a local endpoint's URL must point at, derived from the registry rather than restated. */
export const LOCAL_INGEST_BASE_URL = `http://localhost:${DEV_APPS.engine.port}`;

/**
 * The dev command for one app — the single place the port reaches a command line.
 * @param {string} app
 * @returns {string}
 */
export function devCommand(app) {
  const spec = DEV_APPS[app];
  if (!spec) throw new Error(`dev-ports: unknown app "${app}"`);
  if (spec.kind === "next") return `next dev -p ${spec.port}`;
  if (spec.kind === "opennext") {
    return `opennextjs-cloudflare build && opennextjs-cloudflare preview -- --port ${spec.port} --ip 127.0.0.1`;
  }
  return `wrangler dev --port ${spec.port} --ip 127.0.0.1`;
}

/** Ports assigned more than once. Empty is the only acceptable answer. */
export function duplicatePorts() {
  /** @type {Map<number, string[]>} */
  const seen = new Map();
  for (const [app, spec] of Object.entries(DEV_APPS)) {
    seen.set(spec.port, [...(seen.get(spec.port) ?? []), app]);
  }
  return [...seen.entries()]
    .filter(([, apps]) => apps.length > 1)
    .map(([port, apps]) => ({ port, apps }));
}
