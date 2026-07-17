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
// The deploy path runs AFTER gen-wrangler-prod.mjs, and checks whatever bindings the overlays it emitted
// declare. Two things that are NOT true of that set, both of which this comment previously claimed:
//   - it is not "exactly what this run ships" (the generator emits every app's overlay, not just the
//     deploying one), and
//   - it is not "every app's bindings regardless of workflow": the generator STRIPS an `@gen-optional` block
//     whose id var the calling workflow does not forward, so a pool checked on a deploy.yml run is absent on
//     a deploy-web.yml run. Coverage varies BY WORKFLOW.
// Checking the union of what was emitted is still the right behaviour — a binding on a caching pool is a leak
// whichever deploy noticed it — but the report says which bindings it saw precisely because that set is not
// fixed.

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(ROOT, "apps");

// There is deliberately NO exemption list here. One existed — CACHING_ALLOWED_BINDINGS = ["HYPERDRIVE_CACHED"]
// — and it WAS the hole, twice, because it skipped the binding BY NAME for every app:
//   round 5: an app binding only HYPERDRIVE_CACHED passed the floor (which counted bindings), passed pinning
//            (<HYPERDRIVE_CACHED_ID> IS its own placeholder), and was skipped by the posture check.
//   round 7: after the floor was fixed to demand the tenant binding by name, an app could simply declare
//            BOTH and route its org-wide reads (no org_id bound ⇒ ONE cache key for every org) through the
//            cached one. Still green on all three layers.
// The exemption existed solely to accommodate a binding that ZERO source files ever read. Deleting the
// binding deletes the exemption, which deletes the hole — so the rule is now ABSOLUTE: every hyperdrive
// binding must resolve to a pool with caching disabled. If a genuinely cache-safe read ever needs one,
// re-add the binding and an exemption scoped to an (app, binding) PAIR, never a bare name.

/**
 * The apps that connect to Postgres, and therefore MUST declare the tenant binding.
 *
 * A global "did we find ANY bindings?" check only fires when EVERY app breaks at once — so moving ONE app to
 * a filename discovery misses dropped it silently while the guard printed a completeness claim over the rest.
 * Naming the apps makes a single app's disappearance a red build.
 *
 * Kept honest by a test asserting this equals the set of apps whose SHIPPED wrangler config declares the
 * tenant binding — so adding a sixth DB-touching app without listing it here goes red.
 */
export const DB_APPS = ["engine", "api", "mcp", "web", "auth"];

/**
 * The binding every DB-touching app reads tenant data through. The floor demands THIS BY NAME, not merely
 * "some binding": counting was a hole. An app whose only binding was the cache-exempt HYPERDRIVE_CACHED
 * satisfied a count-based floor, pinned correctly (`<HYPERDRIVE_CACHED_ID>` IS its own placeholder), and was
 * skipped by the posture check (exempt by name) — so all three layers returned zero violations for an app
 * reading tenant data through the CACHING pool, and it never even appeared in the deploy report.
 */
export const REQUIRED_TENANT_BINDING = "HYPERDRIVE_TENANT";

/**
 * Which DB-touching apps did NOT declare the tenant binding — absent from discovery, or present without it.
 * @param {ReadonlyArray<{name: string, bindings: ReadonlyArray<{binding: string}>}>} seen @returns {string[]}
 */
export function missingDbApps(seen) {
  const byApp = new Map((seen ?? []).map((s) => [s.name, s.bindings ?? []]));
  return DB_APPS.filter(
    (app) => !(byApp.get(app) ?? []).some((b) => b.binding === REQUIRED_TENANT_BINDING),
  );
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
  // EVERY place wrangler accepts a hyperdrive array, per its own config-schema.json: the top level, each
  // `env.<name>`, and the `previews` block on BOTH (RawConfig.previews and RawEnvironment.previews). Reading
  // fewer of these is how a binding goes invisible — that has now been the under-match twice (a brace in a
  // comment, then env sections), so this enumerates the schema rather than the shapes we happen to use today.
  //
  // Note this UNIONS the sections rather than modelling wrangler's env REPLACE semantics. Deliberate: a guard
  // that over-approximates checks a binding that may not deploy (harmless), while one that under-approximates
  // misses a binding that does (a leak). Over-checking is the only safe direction here.
  const envs = Object.values(config?.env ?? {});
  const sections = [config, config?.previews, ...envs, ...envs.map((e) => e?.previews)];
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
      // A malformed ENTRY is refused for the same reason a malformed key is: silently dropping it checks
      // less than we claim. Previously this filtered them out — one level down from where the throw lived.
      if (typeof e?.binding !== "string" || typeof e?.id !== "string") {
        throw new Error(
          "a wrangler `hyperdrive` entry is missing a string `binding` or `id` — refusing to skip it.",
        );
      }
      out.push({ binding: e.binding, id: e.id });
    }
  }
  return out;
}

/**
 * Configs that exist but are NEVER deployed by a workflow, and so carry no prod tenant risk.
 *
 * `wrangler.bench.jsonc` is the ingest-benchmark harness: its own header says it is "deployed ONLY for the
 * benchmark window, then torn down with the bench Neon branch + Hyperdrive config", and its Hyperdrive is
 * created ad-hoc at bench time (`wrangler hyperdrive create`) rather than referencing a prod pool. It also
 * uses a different naming convention (binding `HYPERDRIVE`, id `<BENCH_HYPERDRIVE_ID>`), so the pinning rule
 * does not apply to it. Excluded BY NAME so the exclusion is a decision on the record, not a glob that
 * happens to miss it — and so a new variant config is covered by default.
 */
const NON_DEPLOYED_CONFIGS = new Set(["engine/wrangler.bench.jsonc"]);

/** `wrangler.jsonc` → also `wrangler.bench.jsonc`; `wrangler.prod.jsonc` → itself only. */
function matchesConfig(file, filename) {
  if (filename === "wrangler.jsonc")
    return /^wrangler(\..+)?\.jsonc$/.test(file) && !file.endsWith(".prod.jsonc");
  return file === filename;
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
  for (const { name, file, text } of configs) {
    for (const { binding, id } of hyperdriveBindings(text)) {
      const want = placeholderFor(binding);
      if (id === want) continue;
      violations.push(
        `apps/${name}/${file ?? "wrangler.jsonc"}: binding "${binding}" uses id ${JSON.stringify(id)}, expected ` +
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
    // Parse defensively: a 5xx from an edge can be HTML, and letting `.json()` throw would surface a bare
    // SyntaxError instead of the status — which is what an operator needs to tell "CF is down" from "the
    // token lost its Hyperdrive:Read scope".
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
      // Cloudflare error bodies are {success:false, errors:[{code,message}]} and never echo the request's
      // Authorization header, so this cannot reflect the token.
      throw new Error(
        `Cloudflare API error (${res.status}): ${JSON.stringify(body?.errors ?? [])}`,
      );
    }
    const result = body.result ?? [];
    pages.push(result);
    // total_pages is AUTHORITATIVE when present; the short-page rule is the FALLBACK for when it is not.
    // These must not be OR'd: under a per_page cap (CF returning 50 when asked for 100) every page is
    // "short", so an OR lets the fallback truncate the walk at page 1 while total_pages says there is more —
    // dropping configs, failing each dropped id closed, and wedging every prod deploy over a leak that does
    // not exist. That is worse than either signal alone, and is exactly what the OR shipped.
    const totalPages = body.result_info?.total_pages;
    const done = typeof totalPages === "number" ? page >= totalPages : result.length < perPage;
    if (done) return configsByIdFromPages(pages);
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
  const apps = (await readdir(APPS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory());
  const out = [];
  for (const { name } of apps) {
    const dir = join(APPS_DIR, name);
    let files;
    try {
      files = await readdir(dir);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    // Every wrangler config VARIANT, not just the exact filename: apps/engine/wrangler.bench.jsonc already
    // declares a hyperdrive binding that an exact-filename match left outside layer 1 entirely. Globbing means
    // a NEW variant is covered by default rather than silently unchecked.
    for (const file of files.filter((f) => matchesConfig(f, filename))) {
      if (NON_DEPLOYED_CONFIGS.has(`${name}/${file}`)) continue;
      out.push({ name, file, text: await readFile(join(dir, file), "utf8") });
    }
  }
  return out;
}

/**
 * Refuse to report a posture unless EVERY DB-touching app contributed at least one binding. Shared by both
 * entry points, because a completeness claim over a set we failed to discover is the failure this file exists
 * to cure — and it committed that failure twice already.
 * @param {ReadonlyArray<{name: string, text: string}>} configs
 */
function assertEveryDbAppSeen(configs) {
  // Merge across an app's config VARIANTS (an app can ship more than one wrangler config).
  const byApp = new Map();
  for (const { name, text } of configs) {
    byApp.set(name, [...(byApp.get(name) ?? []), ...hyperdriveBindings(text)]);
  }
  const missing = missingDbApps([...byApp].map(([name, bindings]) => ({ name, bindings })));
  if (missing.length > 0) {
    throw new Error(
      `these apps connect to Postgres but do not declare ${REQUIRED_TENANT_BINDING}: ${missing.join(", ")}. ` +
        "Refusing to report a posture that skips them — did a wrangler config get renamed, lose its tenant " +
        "binding, or move it somewhere this guard does not read?",
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
  const checked = bindings;
  const byApp = new Map();
  for (const b of checked) byApp.set(b.app, [...(byApp.get(b.app) ?? []), b.binding]);
  console.log(
    `✔ Hyperdrive cache posture: caching is disabled on every pool the ${checked.length} binding(s) below ` +
      "resolve to. This is exactly what was checked — the generated overlays' bindings, nothing more:",
  );
  for (const [app, list] of byApp) console.log(`    ${app}: ${list.sort().join(", ")}`);
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
