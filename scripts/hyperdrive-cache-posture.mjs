#!/usr/bin/env node
// Keep tenant-scoped reads off a CACHING Hyperdrive pool. Two layers, one cheap and one thorough.
//
// WHY THIS EXISTS. Hyperdrive's query cache is keyed on SQL + bound params and is BLIND to the RLS session
// GUC (`app.current_org`) that `withTenant` sets — packages/db/src/client.ts:18-23 says so directly. The
// tenant reads deliberately carry NO org_id predicate (RLS supplies it), so an org-wide browse has no per-org
// bound param at all: `listDeliveries` (packages/db/src/reads.ts) literally runs `where true`. Its cache key
// is therefore IDENTICAL across every org. Point a tenant read at a caching pool and org A's dashboard
// renders org B's rows — silently, with no error anywhere.
//
// Two things must hold, and the repo previously enforced NEITHER:
//   1. SELECTION — a tenant binding must resolve to the tenant pool, never to the cached one. The committed
//      wrangler.jsonc files carry `<HYPERDRIVE_*_ID>` placeholders, and gen-wrangler-prod.mjs's per-app
//      allow-list permits engine to use BOTH `<HYPERDRIVE_TENANT_ID>` and `<HYPERDRIVE_CACHED_ID>` — so
//      nothing stopped someone re-pointing a tenant binding at the cached pool.
//   2. POSTURE — the pool a binding resolves to must actually have caching disabled. That lived only in an
//      out-of-repo Cloudflare config object, asserted by a COMMENT in apps/web/wrangler.jsonc claiming
//      "(cache-disabled …)" beside a binding that sets no `caching` key at all.
//
// `bindingPlaceholderViolations` closes (1) at LINT time, no network: every hyperdrive binding must be pinned
// to its OWN id placeholder (`HYPERDRIVE_TENANT` ⇒ `<HYPERDRIVE_TENANT_ID>`). `cachePostureViolations` closes
// (2) at DEPLOY time by resolving the GENERATED overlay's real ids against the Cloudflare API.
//
// FAIL CLOSED. Hyperdrive caching is ON by default, so an absent/unreadable `caching.disabled` is the
// DANGEROUS case, never the benign one — anything we cannot prove is disabled is a violation.
//
// HONESTY. The deploy layer reports exactly WHICH bindings it checked, per app. It must never print a
// completeness claim ("all N pools are clean") over a set it did not enumerate — that is the same
// claims-outrun-the-code failure this file exists to cure.
//
// Usage:
//   node scripts/hyperdrive-cache-posture.mjs --lint     (no network; wired into `pnpm lint`)
//   node scripts/hyperdrive-cache-posture.mjs            (deploy preflight; needs CLOUDFLARE_ACCOUNT_ID +
//                                                         CLOUDFLARE_API_TOKEN and the generated overlays)
// The deploy path runs AFTER gen-wrangler-prod.mjs. That generator emits EVERY app's wrangler.prod.jsonc on
// every run — not only the apps the calling workflow deploys — so this checks every app's bindings regardless
// of which workflow invoked it. That is deliberate: a binding resolving to a caching pool is a tenant leak no
// matter which deploy noticed it, so blocking all of them is right. It is NOT "exactly what this run ships",
// and this comment used to say that it was.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(ROOT, "apps");

/**
 * The ONLY binding permitted to resolve to a caching pool. `webhook-prod-cached` exists precisely so the
 * cacheable, NON-tenant-scoped reads have somewhere to go — keeping the tenant pool free to stay uncached.
 * eslint.config.mjs independently bans app code from reading `env.HYPERDRIVE_CACHED`.
 */
export const CACHING_ALLOWED_BINDINGS = ["HYPERDRIVE_CACHED"];

/**
 * The apps that connect to Postgres, and therefore MUST declare at least one hyperdrive binding.
 *
 * This list is the floor's whole point. A global "did we find ANY bindings?" check only fires when EVERY app
 * breaks at once — so moving ONE app to a filename discovery misses (wrangler.json / wrangler.toml are both
 * valid) dropped it silently while the guard still printed a completeness claim over the others. Naming the
 * apps makes a single app's disappearance a red build.
 *
 * Kept honest by a test asserting this equals the set of apps whose wrangler config declares a hyperdrive
 * binding — so adding a sixth DB-touching app without listing it here goes red.
 */
export const DB_APPS = ["engine", "api", "mcp", "web", "auth"];

/**
 * Which DB-touching apps did NOT contribute a binding — either absent from discovery, or found with none.
 * @param {ReadonlyArray<{name: string, bindings: number}>} seen @returns {string[]}
 */
export function missingDbApps(seen) {
  const counted = new Map((seen ?? []).map((s) => [s.name, s.bindings]));
  return DB_APPS.filter((app) => (counted.get(app) ?? 0) === 0);
}

/**
 * Every entry of a wrangler config's `hyperdrive` array, as `{binding, id}`, in file order.
 *
 * PARSED, never text-scanned. The first version of this file regex'd for flat `{...}` chunks, which was wrong
 * in both directions and a code review proved both against the real configs:
 *   - UNDER-match: apps/engine/wrangler.jsonc already puts prose comments INSIDE the hyperdrive object braces.
 *     A single brace in any such comment (`${VAR}`, `caching: { … }`) breaks the chunk, silently dropping that
 *     binding from BOTH layers — so a tenant binding re-pointed at the cached pool produced ZERO violations.
 *   - OVER-match: apps/mcp + apps/web document deploy-injected bindings as commented-out JSON in exactly the
 *     shape the regex harvested, so a comment could turn `pnpm lint` red for a binding that does not exist.
 * Parsing removes both REGEX failure modes at the root: comments are comments, and only real arrays are
 * consulted. It did not make the read complete on its own — the first parsed version read ONLY the top-level
 * `hyperdrive` key and so silently missed `env.<name>` sections, which is a third under-match this now covers.
 *
 * FAILS LOUD on a parse error — reporting bindings from a partial parse is how a guard silently checks less
 * than it claims.
 * @param {unknown} text @returns {Array<{binding: string, id: string}>}
 */
export function hyperdriveBindings(text) {
  if (typeof text !== "string") return [];
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const config = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `could not parse the wrangler config as JSONC (${errors.length} error(s), first at offset ` +
        `${errors[0].offset}) — refusing to report bindings from a partial parse.`,
    );
  }
  // Top level AND every `env.<name>` section. Wrangler supports env sections natively and
  // apps/play/wrangler.jsonc already uses one — reading only the top-level key silently yielded ZERO bindings
  // for a config that declares them under an env, so a tenant binding re-pointed at the cached pool inside an
  // env section passed both layers green. A `hyperdrive` key that is present but NOT an array is a malformed
  // config, not "no bindings": refuse it rather than swallow it.
  const sections = [config, ...Object.values(config?.env ?? {})];
  const out = [];
  for (const section of sections) {
    if (section?.hyperdrive === undefined) continue;
    if (!Array.isArray(section.hyperdrive)) {
      throw new Error(
        "the wrangler config's `hyperdrive` key is present but not an array — refusing to read it as " +
          '"no bindings".',
      );
    }
    for (const e of section.hyperdrive) {
      if (typeof e?.binding === "string" && typeof e?.id === "string") {
        out.push({ binding: e.binding, id: e.id });
      }
    }
  }
  return out;
}

/** The id placeholder a binding MUST use: `HYPERDRIVE_TENANT` ⇒ `<HYPERDRIVE_TENANT_ID>`. */
const placeholderFor = (binding) => `<${binding}_ID>`;

/**
 * LAYER 1 (lint, no network): every hyperdrive binding in a COMMITTED wrangler.jsonc must be pinned to its own
 * id placeholder. This is what makes "a tenant read never runs through the cached pool" a checked property
 * rather than a comment — and it catches the re-pointing at PR time, before any deploy.
 *
 * A literal (non-placeholder) id is also a violation: real resource ids must never be committed (no-secrets),
 * and a literal would silently dodge the pinning check.
 * @param {ReadonlyArray<{name: string, text: string}>} configs @returns {string[]}
 */
export function bindingPlaceholderViolations(configs) {
  if (!Array.isArray(configs)) return ["could not read the wrangler configs (fail closed)"];
  const violations = [];
  for (const { name, text } of configs) {
    for (const { binding, id } of hyperdriveBindings(text)) {
      const want = placeholderFor(binding);
      if (id === want) continue;
      violations.push(
        `apps/${name}/wrangler.jsonc: binding "${binding}" uses id ${JSON.stringify(id)}, expected ` +
          `"${want}". A hyperdrive binding must be pinned to its OWN pool: pointing one at another pool's ` +
          "placeholder (e.g. a tenant read at <HYPERDRIVE_CACHED_ID>) would run RLS-scoped queries through a " +
          "caching pool, whose cache key is blind to the org GUC — serving one org's rows to another.",
      );
    }
  }
  return violations;
}

/**
 * LAYER 2 (deploy): every binding that is not cache-allowed must resolve to a config we can READ and that
 * reports `caching.disabled === true`. Strict `=== true` (not truthiness) so a stringy or absent value can
 * never pass.
 * @param {{bindings: ReadonlyArray<{app: string, binding: string, id: string}>,
 *          configsById: Record<string, unknown>}} input
 * @returns {string[]}
 */
export function cachePostureViolations({ bindings, configsById } = {}) {
  if (!Array.isArray(bindings)) return ["could not read the Hyperdrive bindings (fail closed)"];
  const byId = configsById ?? {};
  const violations = [];
  for (const { app, binding, id } of bindings) {
    if (CACHING_ALLOWED_BINDINGS.includes(binding)) continue;
    // `Object.hasOwn` so a config id can never alias an Object.prototype key and read back a bogus "config".
    const config = Object.hasOwn(byId, id) ? byId[id] : undefined;
    if (!config || typeof config !== "object") {
      violations.push(
        `${app}: ${binding} (${id}) — the Hyperdrive config could not be read, so caching cannot be proven ` +
          "disabled (fail closed).",
      );
      continue;
    }
    if (config.caching?.disabled !== true) {
      violations.push(
        `${app}: ${binding} (${id}, "${config.name ?? "?"}") — caching is ENABLED. Hyperdrive's cache key is ` +
          "SQL+params and is blind to the RLS org GUC, and the org-wide browse reads bind no org_id — so a " +
          "cached row set would be served across tenants. Disable caching on this config, or re-point the " +
          "binding.",
      );
    }
  }
  return violations;
}

/** Merge Cloudflare list PAGES into a null-prototype `{ [id]: config }`. */
export function configsByIdFromPages(pages) {
  const byId = Object.create(null);
  for (const page of pages ?? []) for (const c of page ?? []) byId[c.id] = c;
  return byId;
}

/**
 * Fetch EVERY Hyperdrive config, following pagination. The endpoint defaults to per_page=20 and the account is
 * already at 16 — paging off page 1 would drop configs, and every dropped id fails closed, wedging every prod
 * deploy with an error pointing at a leak that does not exist.
 */
export async function fetchAllConfigs(accountId, token, fetchImpl = fetch, perPage = 100) {
  const pages = [];
  // Stop on EITHER signal, so neither one alone can silently truncate the set:
  //
  //   - `result_info.total_pages` when the response carries it. VERIFIED against the live account: CF does
  //     send it (`{"page":1,"per_page":100,"count":16,"total_count":16,"total_pages":1}`) and it honours the
  //     requested per_page rather than capping it. A review speculated this field was "only our own fake
  //     known to emit it" and I repeated that as fact in an earlier commit message — it is wrong; the API
  //     sends it. Corrected here rather than left standing.
  //   - a SHORT page, which needs no result_info at all. This is the fallback if CF ever drops the field or
  //     caps per_page below the request — either of which would otherwise end the walk early, fail every
  //     dropped id closed, and wedge EVERY prod deploy citing a leak that does not exist.
  //
  // Using both means the loop is correct under CF's actual behaviour AND under the behaviour it was feared
  // to have. MAX_PAGES is a runaway backstop, not a limit we expect to reach — if it trips that is a bug
  // HERE, so it throws rather than silently reporting a posture over a truncated set.
  const MAX_PAGES = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs` +
      `?per_page=${perPage}&page=${page}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (!res.ok || !body?.success) {
      // Cloudflare error bodies are {success:false, errors:[{code,message}]} and never echo the request's
      // Authorization header, so this cannot reflect the token.
      throw new Error(
        `Cloudflare API error (${res.status}): ${JSON.stringify(body?.errors ?? [])}`,
      );
    }
    const result = body.result ?? [];
    pages.push(result);
    const totalPages = body.result_info?.total_pages;
    const doneByTotal = typeof totalPages === "number" && page >= totalPages;
    const doneByShortPage = result.length < perPage;
    if (doneByTotal || doneByShortPage) return configsByIdFromPages(pages);
  }
  throw new Error(
    `Hyperdrive config listing did not terminate within ${MAX_PAGES} pages — refusing to report a posture ` +
      "over a possibly-truncated set.",
  );
}

/**
 * Read one config per app, or null when the app simply has no such file.
 *
 * ONLY an ENOENT is "this app isn't a Worker" — every other error (EACCES, EISDIR, a decoding fault) is
 * rethrown. A blanket `catch { return null }` here is how the whole guard goes quietly green: a read fault
 * would drop the app, and the caller would cheerfully report that every binding it found is fine.
 */
async function readAppConfigs(filename) {
  const apps = await readdir(APPS_DIR, { withFileTypes: true });
  const configs = await Promise.all(
    apps
      .filter((d) => d.isDirectory())
      .map(async ({ name }) => {
        try {
          return { name, text: await readFile(join(APPS_DIR, name, filename), "utf8") };
        } catch (err) {
          if (err?.code === "ENOENT") return null;
          throw err;
        }
      }),
  );
  return configs.filter(Boolean);
}

/**
 * Refuse to report a posture unless EVERY DB-touching app contributed at least one binding. Shared by both
 * entry points, because a completeness claim over a set we failed to discover is the failure this file exists
 * to cure — and it committed that failure twice already.
 * @param {ReadonlyArray<{name: string, text: string}>} configs
 */
function assertEveryDbAppSeen(configs) {
  const seen = configs.map(({ name, text }) => ({
    name,
    bindings: hyperdriveBindings(text).length,
  }));
  const missing = missingDbApps(seen);
  if (missing.length > 0) {
    throw new Error(
      `these apps connect to Postgres but contributed no hyperdrive binding: ${missing.join(", ")}. ` +
        "Refusing to report a posture that skips them — did a wrangler config get renamed (wrangler.json / " +
        ".toml are both valid), or move its bindings somewhere this guard does not read?",
    );
  }
}

async function lintMain() {
  const configs = await readAppConfigs("wrangler.jsonc");
  const bindings = configs.flatMap((c) => hyperdriveBindings(c.text));
  // PER-APP floor. A global "did we find any bindings?" check only fires when EVERY app breaks at once — so
  // moving ONE app to a filename discovery misses (wrangler.json / wrangler.toml are both valid to wrangler)
  // dropped it silently while this still printed a completeness claim over the rest. Naming the DB-touching
  // apps makes a single app's disappearance a red build.
  assertEveryDbAppSeen(configs);
  const violations = bindingPlaceholderViolations(configs);
  if (violations.length > 0) {
    console.error("✖ Hyperdrive binding pinning: a binding does not point at its own pool:\n");
    for (const v of violations) console.error(`  ${v}\n`);
    process.exit(1);
  }
  console.log(
    `✔ Hyperdrive binding pinning: all ${bindings.length} binding(s) across ${configs.length} app config(s) ` +
      "point at their own pool's placeholder.",
  );
}

async function deployMain() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    throw new Error(
      "hyperdrive-cache-posture needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN. This preflight runs on " +
        "the deploy path only; it must never be wired into a pull_request job (it would need the prod token).",
    );
  }
  const overlays = await readAppConfigs("wrangler.prod.jsonc");
  if (overlays.length === 0) {
    throw new Error(
      "no apps/*/wrangler.prod.jsonc found — run scripts/gen-wrangler-prod.mjs first. Refusing to report a " +
        "clean posture over zero bindings.",
    );
  }
  // Same PER-APP floor as the lint layer: ONE app missing from the overlays must not pass as clean.
  assertEveryDbAppSeen(overlays);
  const bindings = overlays.flatMap(({ name, text }) =>
    hyperdriveBindings(text).map((b) => ({ app: name, ...b })),
  );

  const violations = cachePostureViolations({
    bindings,
    configsById: await fetchAllConfigs(accountId, token),
  });
  if (violations.length > 0) {
    console.error(
      "✖ Hyperdrive cache posture: a tenant-scoped binding resolves to a caching pool:\n",
    );
    for (const v of violations) console.error(`  ${v}\n`);
    process.exit(1);
  }
  // Report exactly WHAT was checked — never a completeness claim over a set we did not enumerate.
  const checked = bindings.filter((b) => !CACHING_ALLOWED_BINDINGS.includes(b.binding));
  const byApp = new Map();
  for (const b of checked) byApp.set(b.app, [...(byApp.get(b.app) ?? []), b.binding]);
  console.log(
    `✔ Hyperdrive cache posture: caching is disabled on every pool the ${checked.length} binding(s) below ` +
      "resolve to. This is exactly what was checked — the generated overlays' bindings, nothing more:",
  );
  for (const [app, list] of byApp) console.log(`    ${app}: ${list.sort().join(", ")}`);
  const exempt = bindings.filter((b) => CACHING_ALLOWED_BINDINGS.includes(b.binding));
  if (exempt.length > 0) {
    console.log(`    (exempt by design: ${[...new Set(exempt.map((b) => b.binding))].join(", ")})`);
  }
}

// Run only when invoked directly (not when imported by the test — which would trip process.exit).
if (process.argv[1] && (await readFile(process.argv[1], "utf8").catch(() => null)) !== null) {
  const self = fileURLToPath(import.meta.url);
  const { realpath } = await import("node:fs/promises");
  // realpath both sides: a symlinked or relative argv would otherwise silently skip main() — the guard would
  // exit 0 having checked nothing.
  const [argvReal, selfReal] = await Promise.all([
    realpath(process.argv[1]).catch(() => process.argv[1]),
    realpath(self).catch(() => self),
  ]);
  if (argvReal === selfReal) {
    await (process.argv.includes("--lint") ? lintMain() : deployMain());
  }
}
