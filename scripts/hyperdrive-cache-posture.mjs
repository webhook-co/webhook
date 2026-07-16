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
// The deploy path runs AFTER gen-wrangler-prod.mjs, which emits every app's wrangler.prod.jsonc each run, and
// strips an `@gen-optional` binding whose id var is unset — so the overlays name exactly what this run ships.

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
 * Every entry of a wrangler config's `hyperdrive` array, as `{binding, id}`, in file order.
 *
 * PARSED, never text-scanned. The first version of this file regex'd for flat `{...}` chunks, which was wrong
 * in both directions and a code review proved both against the real configs:
 *   - UNDER-match: apps/engine/wrangler.jsonc already puts prose comments INSIDE the hyperdrive object braces.
 *     A single brace in any such comment (`${VAR}`, `caching: { … }`) breaks the chunk, silently dropping that
 *     binding from BOTH layers — so a tenant binding re-pointed at the cached pool produced ZERO violations.
 *   - OVER-match: apps/mcp + apps/web document deploy-injected bindings as commented-out JSON in exactly the
 *     shape the regex harvested, so a comment could turn `pnpm lint` red for a binding that does not exist.
 * Reading `config.hyperdrive` after a real JSONC parse removes both failure modes at the root: comments are
 * comments, and only the actual array is consulted.
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
  const entries = Array.isArray(config?.hyperdrive) ? config.hyperdrive : [];
  return entries
    .filter((e) => typeof e?.binding === "string" && typeof e?.id === "string")
    .map(({ binding, id }) => ({ binding, id }));
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
export async function fetchAllConfigs(accountId, token, fetchImpl = fetch) {
  const pages = [];
  for (let page = 1; ; page++) {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs` +
      `?per_page=100&page=${page}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    if (!res.ok || !body?.success) {
      // Cloudflare error bodies are {success:false, errors:[{code,message}]} and never echo the request's
      // Authorization header, so this cannot reflect the token.
      throw new Error(
        `Cloudflare API error (${res.status}): ${JSON.stringify(body?.errors ?? [])}`,
      );
    }
    pages.push(body.result ?? []);
    const totalPages = body.result_info?.total_pages ?? 1;
    if (page >= totalPages || (body.result ?? []).length === 0) break;
  }
  return configsByIdFromPages(pages);
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

async function lintMain() {
  const configs = await readAppConfigs("wrangler.jsonc");
  const bindings = configs.flatMap((c) => hyperdriveBindings(c.text));
  // The same floor deployMain has. Without it, a discovery break (an app's config renamed to wrangler.json,
  // a Worker on wrangler.toml) makes `bindingPlaceholderViolations([])` return [] and this print
  // "✔ every binding …" over NOTHING — the exact claims-outrun-the-code failure this file exists to cure.
  if (bindings.length === 0) {
    throw new Error(
      `found no hyperdrive bindings across ${configs.length} app config(s) — refusing to report "every ` +
        'binding pinned" over an empty set. Did an app config get renamed?',
    );
  }
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
  const bindings = overlays.flatMap(({ name, text }) =>
    hyperdriveBindings(text).map((b) => ({ app: name, ...b })),
  );
  if (bindings.length === 0) {
    throw new Error(
      "the generated overlays declare no hyperdrive bindings — refusing to report clean.",
    );
  }

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
