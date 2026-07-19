#!/usr/bin/env node
// Keep Cloudflare native tracing OFF any Worker that carries a secret in its URL. Lint-time, no network.
//
// WHY THIS EXISTS. Cloudflare's automatic tracing (observability.traces, open beta) emits a fetch span for
// every incoming request recording `url.full`, `url.path`, and `url.query` VERBATIM — with NO application
// redaction hook (developers.cloudflare.com/workers/observability/traces/spans-and-attributes/). So enabling
// tracing on a Worker whose URL ever contains a token, OAuth code, reset ticket, or signed-URL signature
// exfiltrates a LIVE credential into the trace store, and — if a destination is ever attached — off Cloudflare
// entirely. This is the exact same class of leak that inverted the whole S6 tracing plan (ADR-0124/0125): the
// engine's ingest bearer token IS the first URL path segment.
//
// THE AUDIT THIS ENFORCES (firsthand, 2026-07-19; see ADR-0124). Each Worker was read end-to-end for any
// secret reaching url.path or url.query (a secret in a header or POST body is fine — it is not in the span):
//   SAFE (bearer strictly in headers/body; path+query carry only resource ids, filters, or static routes):
//     api, www, get, telemetry.
//   FORBIDDEN (a secret DOES appear in the URL):
//     engine (ingest token = first path segment), auth (?code/?state/?c), web (?ticket/?token), mcp (kept
//     forbidden pending a dedicated re-review — it brokers OAuth with auth), play (sandbox token in path).
//   NO-FETCH (a wrangler config but no fetch handler, so no auto fetch span ever fires): dmarc (email() only).
//
// WHAT IS CHECKED (all fail-closed):
//   1. CLASSIFICATION — every app with a wrangler config must be in exactly one bucket. A brand-new Worker is
//      a red build until someone deliberately classifies it, which forces the URL-secret audit BEFORE anyone
//      can enable tracing on it. This is the load-bearing property: the danger is a future unaudited worker.
//   2. SECURITY — no app outside the SAFE allowlist may enable tracing, in ANY section (top-level OR env.<name>
//      OR previews). Over-approximating (the union) is the safe direction: flagging a trace that might not ship
//      is harmless; missing one that does is a credential leak.
//   3. FLOOR — every app we SHIPPED tracing on (TRACING_ENABLED_APPS) must still have it enabled at the
//      deployable top level, so a silent removal — or a config rename that drops it — goes red rather than
//      quietly disabling observability. An env-only enable does NOT count (a plain `wrangler deploy` never
//      applies it).
//   4. SAMPLING — an enabled worker must declare a DELIBERATE head_sampling_rate in (0, 1]. Absent is a
//      violation (the CF default is 1 = 100%, a cost decision no one made); 0 traces nothing; >1 is invalid.
//
// PARSED, never text-scanned (the lesson from hyperdrive-cache-posture.mjs): comments and env sections are
// read as structure. A parse error FAILS LOUD — reporting over a partial parse is how a guard checks less than
// it claims.
//
// Usage:
//   node scripts/tracing-safety-guard.mjs --lint   (no network; wired into `pnpm lint`)

import { readdir as realReaddir, readFile as realReadFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc } from "jsonc-parser";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(ROOT, "apps");

/**
 * Audited SAFE — tracing MAY be enabled (no secret ever reaches url.path/url.query). Naming them (not globbing)
 * makes each membership a decision on the record; a test asserts this partitions the real repo with the other
 * two buckets, so a new worker cannot slip in unclassified.
 */
export const TRACING_SAFE_APPS = new Set(["api", "www", "get", "telemetry"]);

/**
 * Audited FORBIDDEN — a secret appears in the URL, so the auto fetch span would capture it. Tracing must NEVER
 * be enabled here. This set drives a precise error message and a live test that none of them carry tracing;
 * the enforcement itself is "enabled ⟹ in SAFE", so even an unlisted worker is caught.
 */
export const TRACING_FORBIDDEN_APPS = new Set(["engine", "auth", "web", "mcp", "play"]);

/** A wrangler config but no fetch handler (email/queue only) — no auto fetch span can fire. */
export const TRACING_NO_FETCH_APPS = new Set(["dmarc"]);

/**
 * Where tracing is actually SHIPPED (the floor). MUST be a subset of TRACING_SAFE_APPS — a test enforces that,
 * so you can never ship tracing on a worker that was not audited safe.
 */
export const TRACING_ENABLED_APPS = new Set(["api", "www", "get"]);

/** @param {string} name @returns {"safe"|"forbidden"|"no-fetch"|"unclassified"} */
export function classifyApp(name) {
  if (TRACING_SAFE_APPS.has(name)) return "safe";
  if (TRACING_FORBIDDEN_APPS.has(name)) return "forbidden";
  if (TRACING_NO_FETCH_APPS.has(name)) return "no-fetch";
  return "unclassified";
}

/** Parse a wrangler config as JSONC, throwing loud on any parse error. @param {unknown} text */
function parseConfig(text) {
  if (typeof text !== "string") {
    throw new Error("wrangler config is not a string — refusing to read it as 'no tracing'.");
  }
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const config = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(
      `could not parse the wrangler config as JSONC (${errors.length} error(s), first at offset ` +
        `${errors[0].offset}) — refusing to read tracing state from a partial parse.`,
    );
  }
  return config ?? {};
}

/** `observability.traces.enabled === true` on one config object (strict true, never truthy). */
const sectionEnablesTraces = (section) => section?.observability?.traces?.enabled === true;

/** An `observability.traces` object is PRESENT on this config object, whatever its `enabled` value. */
const sectionHasTracesConfig = (section) =>
  section?.observability?.traces !== undefined && section?.observability?.traces !== null;

/**
 * TRUE if tracing is enabled at the deployable TOP LEVEL — i.e. what a plain `wrangler deploy` ships. This is
 * what the FLOOR checks: an env-only enable must not satisfy "we shipped tracing here".
 * @param {unknown} text
 */
export function tracesEnabledDeployable(text) {
  return sectionEnablesTraces(parseConfig(text));
}

/**
 * TRUE if tracing is enabled in ANY section — top level, any `env.<name>`, or a `previews` block. This is what
 * the SECURITY check uses: a trace enabled anywhere on a URL-secret worker is a leak, whether or not that
 * section is the one that deploys. Over-approximating is the safe direction.
 * @param {unknown} text
 */
export function tracesEnabledAnySection(text) {
  return anySection(parseConfig(text)).some((s) => sectionEnablesTraces(s));
}

/**
 * TRUE if an `observability.traces` block is PRESENT in any section, regardless of its `enabled` value. The
 * SECURITY check uses this rather than `tracesEnabledAnySection`: a url-secret worker must carry NO traces
 * config at all, so a truthy-but-not-strict-true `enabled` (`1`, `"true"`) — which `enabled === true` would
 * read as "off" while a future/looser runtime might honour — can never slip a trace block onto it unnoticed.
 * @param {unknown} text
 */
export function tracesConfigPresentAnySection(text) {
  return anySection(parseConfig(text)).some((s) => sectionHasTracesConfig(s));
}

/** Every section wrangler can apply a config from: top level, previews, each env.<name>, each env's previews. */
function anySection(config) {
  const envs = Object.values(config?.env ?? {});
  return [config, config?.previews, ...envs, ...envs.map((e) => e?.previews)];
}

/** The top-level head_sampling_rate, or undefined. @param {unknown} text */
export function headSamplingRate(text) {
  return parseConfig(text)?.observability?.traces?.head_sampling_rate;
}

/**
 * The whole policy as a pure function over `[{name, file, text}]`. Returns a (possibly empty) list of
 * human-readable violation strings. Fail-closed on a non-array input.
 * @param {ReadonlyArray<{name: string, file?: string, text: string}>} configs @returns {string[]}
 */
export function tracingSafetyViolations(configs) {
  if (!Array.isArray(configs)) return ["could not read the wrangler configs (fail closed)"];
  const violations = [];

  for (const { name, file = "wrangler.jsonc", text } of configs) {
    const where = `apps/${name}/${file}`;
    const klass = classifyApp(name);

    // 1. CLASSIFICATION — an unclassified worker is a red build regardless of its tracing state.
    if (klass === "unclassified") {
      violations.push(
        `${where}: worker "${name}" is not classified in tracing-safety-guard. Before it can exist here, audit ` +
          "whether any secret (token, OAuth code, ticket, signed-URL signature) ever reaches its url.path or " +
          "url.query. Then add it to TRACING_SAFE_APPS (never) / TRACING_FORBIDDEN_APPS / TRACING_NO_FETCH_APPS.",
      );
      continue; // no point checking tracing rules on an un-audited worker
    }

    // 2. SECURITY — a non-safe worker must carry NO observability.traces block in ANY section. Presence, not
    //    just enabled===true: a truthy-but-not-strict-true `enabled` would read as "off" here yet might be
    //    honoured by a looser runtime, so the block must simply not exist on a url-secret worker at all.
    if (tracesConfigPresentAnySection(text) && klass !== "safe") {
      const reason =
        klass === "forbidden"
          ? "this worker carries a secret in url.path/url.query (e.g. an ingest token, OAuth ?code, or ?ticket), " +
            "and CF's auto fetch span records url.path/url.query with no redaction hook — tracing here would " +
            "exfiltrate a live credential"
          : "this worker has no fetch surface classification that permits tracing";
      violations.push(
        `${where}: an observability.traces block is present on a ${klass} worker — ${reason}. Remove it entirely, ` +
          "or (only after a firsthand URL-secret audit proves it safe) move the worker to TRACING_SAFE_APPS.",
      );
    }

    // 4. SAMPLING — on a SAFE worker (where tracing is allowed), EVERY section that enables traces (top-level
    //    or env.<name>) must declare a deliberate rate in (0, 1]. Checking the union, not just the deployable
    //    top level, so a rate omitted inside an env section a `wrangler deploy --env` would ship at CF's silent
    //    100% default cannot escape validation. Skipped for non-safe workers — there the security check above
    //    already demands the whole traces block be removed, so a rate complaint would be redundant noise.
    if (klass === "safe") {
      for (const section of anySection(parseConfig(text))) {
        if (!sectionEnablesTraces(section)) continue;
        const rate = section.observability.traces.head_sampling_rate;
        if (typeof rate !== "number" || Number.isNaN(rate) || rate <= 0 || rate > 1) {
          violations.push(
            `${where}: observability.traces is enabled but head_sampling_rate is ${JSON.stringify(rate)} — it must ` +
              "be a deliberate number in (0, 1]. The CF default is 1 (100%), a cost/volume decision that must be " +
              "made explicitly, not inherited.",
          );
        }
      }
    }
  }

  // 3. FLOOR — every worker we shipped tracing on must still have it, deployable, in at least one seen config.
  //    This is also the zero-input floor: an empty `configs` reports every enabled app as missing rather than
  //    passing clean.
  for (const name of TRACING_ENABLED_APPS) {
    // Only the deployable main config counts. A malformed config would already have thrown in the per-config
    // loop above (every branch there parses), so by here every config in the list parsed cleanly.
    const shipped = configs.some(
      (c) =>
        c.name === name &&
        (c.file ?? "wrangler.jsonc") === "wrangler.jsonc" &&
        tracesEnabledDeployable(c.text),
    );
    if (!shipped) {
      violations.push(
        `apps/${name}/wrangler.jsonc: expected native tracing to be SHIPPED here (TRACING_ENABLED_APPS) but its ` +
          "deployable top-level observability.traces.enabled is not true. Did the config get renamed, lose the " +
          "block, or move it into an env section a plain `wrangler deploy` never applies?",
      );
    }
  }

  return violations;
}

/**
 * Read every `wrangler*.jsonc` (all variants, e.g. wrangler.bench.jsonc; NOT the generated *.prod.jsonc) under
 * each apps/* dir. ONLY an ENOENT means "not a Worker dir" — every other error is rethrown, so a read fault can
 * never quietly drop an app and let the guard pass. FS injected for tests; defaults are the real disk.
 *
 * SCOPE: only `apps/` is scanned, because that is where every deployable Worker lives today (verified: no
 * wrangler config exists under packages/ / ee/ / infra/). If a deployable Worker is ever added OUTSIDE apps/,
 * widen `appsDir`/this walk to cover it — otherwise it would be neither classified nor checked.
 * @param {{readdir?: typeof realReaddir, readFile?: typeof realReadFile, appsDir?: string}} [deps]
 */
export async function readAppConfigs({
  readdir = realReaddir,
  readFile = realReadFile,
  appsDir = APPS_DIR,
} = {}) {
  const apps = (await readdir(appsDir, { withFileTypes: true })).filter((d) => d.isDirectory());
  const out = [];
  for (const { name } of apps) {
    const dir = join(appsDir, name);
    let files;
    try {
      files = await readdir(dir);
    } catch (err) {
      if (err?.code === "ENOENT") continue;
      throw err;
    }
    // Every `wrangler*.jsonc` variant (e.g. wrangler.bench.jsonc) but NOT the generated *.prod.jsonc. A plain
    // string predicate rather than a regex — clearer, and it sidesteps the ReDoS lint on `(\..+)?`.
    for (const file of files.filter(
      (f) => f.startsWith("wrangler") && f.endsWith(".jsonc") && !f.endsWith(".prod.jsonc"),
    )) {
      out.push({ name, file, text: await readFile(join(dir, file), "utf8") });
    }
  }
  return out;
}

/**
 * The lint entry point (no network). Deps injected so a test drives the orchestration without disk or a real
 * process.exit; the defaults are today's exact behaviour.
 * @param {{readConfigs?: typeof readAppConfigs, log?: typeof console.log, error?: typeof console.error,
 *          exit?: typeof process.exit}} [deps]
 */
export async function lintMain({
  readConfigs = readAppConfigs,
  log = console.log,
  error = console.error,
  exit = process.exit,
} = {}) {
  const configs = await readConfigs();
  const violations = tracingSafetyViolations(configs);
  if (violations.length > 0) {
    error(
      "✖ Native tracing safety: tracing is enabled where it must not be, or missing where it must be:\n",
    );
    for (const v of violations) error(`  ${v}\n`);
    exit(1);
    // A real process.exit never returns, but an injected test spy does — return so the success log below can
    // never print on top of a failure.
    return;
  }
  const enabled = configs
    .filter(
      (c) => (c.file ?? "wrangler.jsonc") === "wrangler.jsonc" && TRACING_ENABLED_APPS.has(c.name),
    )
    .map((c) => c.name)
    .sort();
  log(
    `✔ Native tracing safety: tracing is enabled ONLY on the audited-safe workers (${enabled.join(", ")}) with a ` +
      `deliberate sampling rate, and OFF every url-secret worker (${[...TRACING_FORBIDDEN_APPS].sort().join(", ")}). ` +
      `${configs.length} config(s) checked.`,
  );
}

// Run only when invoked directly (not when imported by the test — which would trip process.exit).
if (process.argv[1]) {
  const self = fileURLToPath(import.meta.url);
  const { realpath } = await import("node:fs/promises");
  const [argvReal, selfReal] = await Promise.all([
    realpath(process.argv[1]).catch(() => process.argv[1]),
    realpath(self).catch(() => self),
  ]);
  if (argvReal === selfReal) await lintMain();
}
