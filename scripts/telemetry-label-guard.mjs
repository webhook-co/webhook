#!/usr/bin/env node
// Fails if the telemetry metric catalog (packages/shared/src/telemetry-catalog.json) declares an
// unbounded label — the classic observability cost bomb. A single tenant/org/endpoint/event/url label
// makes the metric's time-series count grow LINEARLY with customers (one backend priced this at
// ~$3,250/mo at 500k series). Wired into `pnpm lint`.
//
// It PARSES the catalog (JSON.parse — structured), it does NOT text-scan source: the sibling
// no-unverified-claims guard was unsound precisely because it matched a line at a time, so this one
// reads the whole structure and judges each metric's declared labels against the allowlist. It also
// has a ZERO-INPUT FLOOR: an empty/absent/unparseable catalog is a VIOLATION, so "the guard never ran"
// can never read as "the guard passed." Its tests call validateCatalog/readCatalog directly — the same
// entry points main() runs — because a guard's tests must run the guard.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMain } from "./lib/docs-lib.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(SCRIPTS, "..", "packages", "shared", "src", "telemetry-catalog.json");

// A label key that names an identifier or PII/high-cardinality field — id / org / tenant / endpoint /
// event / user / url / ip / addr / host / path / slug / session / signature / phone / device / hash /
// fingerprint / name / email / secret / password / apikey, etc. Bounded enum keys (outcome, method,
// verified, status_class, attempt_bucket, result, job) never match. This denylist is a backstop; the
// primary bound is that every metric's labels must be a subset of the small, reviewed labelAllowlist.
const ID_SHAPED_KEY =
  /(^|[._-])(id|ids|org|orgs|tenant|tenants|endpoint|endpoints|event|events|user|users|key|keys|token|tokens|url|urls|email|emails|uuid|correlation|delivery|customer|account|ip|ips|addr|host|hosts|path|paths|slug|slugs|session|sessions|sig|signature|signatures|phone|phones|device|devices|hash|fingerprint|name|secret|secrets|password|passwords|apikey|apikeys)([._-]|$)/i;

/** Read + JSON-parse the catalog. Throws on a missing/unparseable file (part of the floor). */
export function readCatalog(path = CATALOG_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Validate a parsed catalog. Returns an array of human-readable violation strings ([] = clean).
 * @param {unknown} catalog
 * @returns {string[]}
 */
export function validateCatalog(catalog) {
  const violations = [];
  if (catalog === null || typeof catalog !== "object") {
    return ["catalog is absent or not an object"];
  }
  const allowlist = catalog.labelAllowlist;
  const metrics = catalog.metrics;

  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    violations.push("labelAllowlist is empty or absent");
  }
  if (metrics === null || typeof metrics !== "object" || Object.keys(metrics ?? {}).length === 0) {
    violations.push("metrics is empty or absent");
  }

  const allowed = new Set(Array.isArray(allowlist) ? allowlist : []);
  for (const key of allowed) {
    if (ID_SHAPED_KEY.test(key)) {
      violations.push(`labelAllowlist contains id-shaped key "${key}" (unbounded cardinality)`);
    }
  }

  for (const [name, def] of Object.entries(metrics ?? {})) {
    const labels = def?.labels;
    if (!Array.isArray(labels)) {
      violations.push(`metric "${name}" has no labels array`);
      continue;
    }
    for (const label of labels) {
      if (ID_SHAPED_KEY.test(label)) {
        violations.push(`metric "${name}" declares id-shaped label "${label}" (cardinality bomb)`);
      }
      if (!allowed.has(label)) {
        violations.push(`metric "${name}" declares label "${label}" not in labelAllowlist`);
      }
    }
  }
  return violations;
}

/** CLI entry: validate the committed catalog; print violations and exit non-zero on any. */
function main() {
  let violations;
  try {
    violations = validateCatalog(readCatalog());
  } catch (err) {
    console.error(
      `telemetry-label-guard: cannot read catalog: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(
      "telemetry-label-guard: unbounded/undeclared metric labels (cost + cardinality risk):",
    );
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "Fix: use a bounded enum label, or move the identifier to an in-CF sink (AE blob / log / Postgres).",
    );
    process.exit(1);
  }
  console.log("telemetry-label-guard: catalog labels are bounded ✓");
}

if (isMain(import.meta.url)) {
  main();
}
