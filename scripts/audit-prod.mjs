#!/usr/bin/env node
// Production-dependency vulnerability audit against npm's BULK advisory endpoint.
//
// Why this exists: `pnpm audit` POSTs to npm's legacy quick-audit endpoint
// (`/-/npm/v1/security/audits`), which npm RETIRED — it now returns HTTP 410
// ("Use the bulk advisory endpoint instead"), so `pnpm audit` fails for every run
// regardless of whether any vulnerability exists. This script talks to the
// replacement npm mandates (`/-/npm/v1/security/advisories/bulk`, the same endpoint
// `npm audit` uses) with nothing but Node built-ins — no third-party GitHub Action
// (the org restricts Actions to GitHub-owned publishers) and no downloaded binary.
//
// Semantics preserved from the old two-step job:
//   --audit-level=critical  → BLOCKING  (exit 1 if any production dep has a critical advisory)
//   --audit-level=high       → advisory  (printed, never fails the build)
//   --prod                   → only production dependencies are considered
//
// Usage: `node scripts/audit-prod.mjs [--level=critical|high]` (default: critical).

import { execSync } from "node:child_process";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

const BULK_ENDPOINT = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
// npm's bulk endpoint caps the request body; audit chunks the package set. Stay well under any cap.
const CHUNK_SIZE = 250;
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/**
 * Collect every PRODUCTION (name → set of versions) pair from parsed `pnpm ls --json` output. Pure, so
 * it can be unit-tested against fixture JSON. A `link:`/`file:`/workspace dep has a non-semver version
 * and is skipped (nothing to audit); transitive prod deps nest under `.dependencies`; `optionalDependencies`
 * are included (they ship if present).
 */
export function parseProdTree(projects) {
  const map = new Map();
  const add = (name, version) => {
    if (!version || !/^\d/.test(version)) return; // skip link:/workspace/non-semver
    if (!map.has(name)) map.set(name, new Set());
    map.get(name).add(version);
  };
  const walk = (deps) => {
    if (!deps || typeof deps !== "object") return;
    for (const [name, info] of Object.entries(deps)) {
      if (!info || typeof info !== "object") continue;
      add(name, info.version);
      walk(info.dependencies);
    }
  };
  for (const project of Array.isArray(projects) ? projects : [projects]) {
    walk(project.dependencies);
    walk(project.optionalDependencies);
  }
  return map;
}

/**
 * Split a bulk-endpoint advisories object ({name: [{severity, title, url}, ...]}) into the BLOCKING
 * bucket (severity at/above `blockingLevel`) and the lower-but-notable ADVISORY bucket (>= high but below
 * the blocking level). Pure — the whole gate decision turns on this, so it is the thing worth testing.
 */
export function classifyAdvisories(advisories, blockingLevel) {
  const blockRank = SEVERITY_RANK[blockingLevel] ?? SEVERITY_RANK.critical;
  const blocking = [];
  const advisoryOnly = [];
  for (const [name, list] of Object.entries(advisories ?? {})) {
    for (const a of list ?? []) {
      const rank = SEVERITY_RANK[a.severity] ?? 0;
      const line = `${name} — ${a.severity} — ${a.title} (${a.url})`;
      if (rank >= blockRank) blocking.push(line);
      else if (rank >= SEVERITY_RANK.high) advisoryOnly.push(line);
    }
  }
  return { blocking, advisoryOnly };
}

/** The requested blocking level from argv (`--level=critical|high`, default critical). */
export function blockingLevelFromArgv(argv) {
  const level = argv.find((a) => a.startsWith("--level="))?.split("=")[1] ?? "critical";
  return level === "high" ? "high" : "critical";
}

/** Collect every PRODUCTION (name → set of versions) pair from the live pnpm dependency tree. */
function collectProdDependencies() {
  // --prod drops root devDependencies; --depth Infinity includes transitive prod deps. -r covers every workspace.
  const raw = execSync("pnpm ls -r --prod --depth Infinity --json", {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseProdTree(JSON.parse(raw));
}

/** POST one chunk of the {name: [versions]} map to the bulk endpoint; returns its advisories object. */
async function fetchAdvisories(chunkEntries) {
  const body = Object.fromEntries(chunkEntries.map(([name, versions]) => [name, [...versions]]));
  const res = await fetch(BULK_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`bulk advisory endpoint returned HTTP ${res.status}`);
  }
  return res.json();
}

async function main() {
  const blockingLevel = blockingLevelFromArgv(process.argv);
  const deps = collectProdDependencies();
  const entries = [...deps.entries()];
  const advisories = {};
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const part = await fetchAdvisories(chunk);
    for (const [name, list] of Object.entries(part)) {
      advisories[name] = (advisories[name] ?? []).concat(list);
    }
  }

  const { blocking, advisoryOnly } = classifyAdvisories(advisories, blockingLevel);

  console.log(
    `audited ${deps.size} production packages against the npm bulk advisory endpoint: ` +
      `${blocking.length} at/above "${blockingLevel}", ${advisoryOnly.length} lower-but-notable`,
  );
  for (const line of advisoryOnly) console.log(`  [advisory] ${line}`);
  for (const line of blocking) console.log(`  [BLOCK]    ${line}`);

  if (blocking.length > 0) {
    console.error(
      `::error::${blocking.length} production dependency advisories at or above "${blockingLevel}" severity`,
    );
    process.exit(1);
  }
}

// Run the network audit ONLY when executed directly (`node scripts/audit-prod.mjs`), never on import —
// the *.test.mjs imports the pure helpers above and must not trigger a live bulk-endpoint call.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((err) => {
    // A transient network/endpoint fault must FAIL the job, not silently pass — a security gate that
    // can't reach its data is not a gate. (The whole reason this script exists is that the old endpoint
    // silently 410'd.) Surface the category and exit non-zero.
    console.error(
      `::error::audit could not complete: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  });
}
