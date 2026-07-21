#!/usr/bin/env node
// Prove the security pins in `pnpm-workspace.yaml` are actually IN FORCE.
//
// A security override is unusual among our guards: it can be present in the file, mirrored into the
// lockfile, look correct in review, and still be doing NOTHING. This repo has shipped that bug twice.
//
//   #124 — the pins sat in package.json's `pnpm.overrides`. pnpm 10 stopped reading that field, so
//          every one of them went inert. Nothing warned; the file still "had" the pins.
//   #718 — `"js-yaml@<4.2.0": "^4.2.0"` while the tree sat at exactly 4.2.0. `<4.2.0` does not match
//          4.2.0, so the key matched nothing and did nothing.
//
// So this guard does not ask "is a pin written down?" — it asks "did the pin MOVE THE TREE?", by
// comparing each override against the versions actually resolved in `pnpm-lock.yaml`.
//
// WHAT IT DELIBERATELY CANNOT DO — stated plainly, because a guard that is believed to cover more
// than it does is worse than no guard. It cannot detect ADVISORY DRIFT: the #718 shape where a new
// GHSA moves a package's fix floor ABOVE the pinned version. At that moment the tree sat at 4.2.0,
// which is not below the key's own 4.2.0 floor, so every rule here passes. Detecting that needs
// advisory data, and Dependabot is the channel that has it. What this guard adds is the other half —
// that a pin we HAVE written is real. When a new advisory lands on an already-pinned package,
// RETARGET the key; never assume the old pin still covers it.
//
// PARSES both YAML files (via `yaml`) rather than text-scanning: a regex over an overrides block
// would be satisfied by the key appearing in a comment, which is a latent lie.
//
// FAIL CLOSED: no overrides, or an empty lockfile, is itself a violation — a guard that reads
// nothing must never read as clean.

import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_FILE = join(ROOT, "pnpm-workspace.yaml");
const LOCK_FILE = join(ROOT, "pnpm-lock.yaml");

/** `X.Y.Z` or `X.Y.Z-prerelease`. Anything else this guard refuses to compare. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** @returns {[number, number, number, string | null] | null} */
function parseVersion(v) {
  const m = VERSION.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null;
}

/** Standard semver ordering, with a prerelease sorting BELOW its own release. */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  if (a[3] === b[3]) return 0;
  if (a[3] === null) return 1; // a is the release, b a prerelease of it
  if (b[3] === null) return -1;
  return comparePrerelease(a[3], b[3]);
}

/**
 * Semver §11: compare dot-separated prerelease identifiers. Numeric identifiers compare
 * numerically (so `rc.2` < `rc.10`, not the string ordering), numeric always sorts below
 * non-numeric, and a shorter run of identifiers sorts below a longer one that shares its prefix.
 */
function comparePrerelease(a, b) {
  const ai = a.split("."),
    bi = b.split(".");
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    if (ai[i] === undefined) return -1;
    if (bi[i] === undefined) return 1;
    if (ai[i] === bi[i]) continue;
    const an = /^\d+$/.test(ai[i]),
      bn = /^\d+$/.test(bi[i]);
    if (an && bn) return Number(ai[i]) - Number(bi[i]);
    if (an !== bn) return an ? -1 : 1; // numeric identifiers have lower precedence
    return ai[i] < bi[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Split an override key into the package it pins and the floor it pins to.
 * `"@hono/node-server@<2.0.5"` → scoped, range-form. `"esbuild"` → bare-form (floor comes from the value).
 */
export function splitKey(key, value) {
  const at = key.lastIndexOf("@<");
  if (at > 0) return { name: key.slice(0, at), floor: key.slice(at + 2), ranged: true };
  return { name: key, floor: String(value), ranged: false };
}

/** The lowest version a range can resolve to, for the shapes we allow in an override value. */
function rangeFloor(value) {
  const m = /^[\^~>=]*\s*(.+)$/.exec(String(value).trim());
  return m ? parseVersion(m[1]) : null;
}

/**
 * The pure decision.
 *
 * @param {{
 *   overrides: Record<string, string>,
 *   resolved: Map<string, string[]>,
 *   documented: Set<string>,
 *   stranded: string[],
 * }} input
 * @returns {string[]} one human-readable violation per problem
 */
export function overrideViolations({ overrides, resolved, documented, stranded }) {
  const violations = [];

  for (const file of stranded ?? []) {
    violations.push(
      `${file}: declares a \`pnpm.overrides\` block. pnpm 10 does NOT read that field — the pins in ` +
        `it are silently inert (this is exactly how #124 stranded every security pin in the repo). ` +
        `Move them to \`overrides:\` in pnpm-workspace.yaml.`,
    );
  }

  const keys = Object.keys(overrides ?? {});
  if (keys.length === 0) {
    violations.push(
      "overrides-guard: pnpm-workspace.yaml declares no overrides, so there is nothing to verify. " +
        "(An empty block reads as clean; that is the bug.)",
    );
    return violations;
  }
  if (!(resolved instanceof Map) || resolved.size === 0) {
    violations.push(
      "overrides-guard: no resolved packages were read from pnpm-lock.yaml, so no pin can be " +
        "checked against the tree it is supposed to have moved.",
    );
    return violations;
  }

  for (const key of keys) {
    const value = overrides[key];
    const { name, floor, ranged } = splitKey(key, value);

    if (!documented?.has(name)) {
      violations.push(
        `\`${key}\`: no comment in pnpm-workspace.yaml mentions \`${name}\`. Every pin carries its ` +
          `reason (GHSA, alert number, why the version is safe) so the next reader can tell a live ` +
          `pin from a stale one.`,
      );
    }

    const floorV = parseVersion(floor);
    if (!floorV) {
      violations.push(
        `\`${key}\`: this guard could not parse \`${floor}\` as a plain X.Y.Z version, so it cannot ` +
          `prove the pin took effect. Use a comparable floor rather than leaving it unchecked.`,
      );
      continue;
    }

    if (ranged) {
      const valueV = rangeFloor(value);
      if (!valueV) {
        violations.push(
          `\`${key}\`: could not parse the override value \`${value}\` as a version range, so the ` +
            `pin cannot be proven to land at or above \`${floor}\`.`,
        );
      } else if (compare(valueV, floorV) < 0) {
        violations.push(
          `\`${key}\`: the key pins everything below \`${floor}\`, but the value \`${value}\` can ` +
            `resolve as low as \`${valueV.slice(0, 3).join(".")}\` — below its own floor, so the ` +
            `override could satisfy itself while leaving a vulnerable version in the tree.`,
        );
      }
    }

    const versions = resolved.get(name) ?? [];
    if (versions.length === 0) {
      violations.push(
        `\`${key}\`: \`${name}\` is not present in pnpm-lock.yaml at all. The pin is dead weight — ` +
          `either the dependency is gone (remove the pin) or the name is misspelled (in which case ` +
          `it has been protecting nothing).`,
      );
      continue;
    }

    const unparseable = versions.filter((v) => !parseVersion(v));
    if (unparseable.length > 0) {
      violations.push(
        `\`${key}\`: \`${name}\` resolves to ${unparseable.map((v) => `\`${v}\``).join(", ")}, ` +
          `which this guard cannot compare against \`${floor}\`. Fail closed rather than assume.`,
      );
      continue;
    }

    // A RANGED key only claims the band below its floor; versions above it (a deliberately
    // untouched major, e.g. brace-expansion's 2.x and 5.x) are none of its business.
    // A BARE key rewrites every copy, so every copy must be the pinned version.
    const offenders = ranged
      ? versions.filter((v) => compare(parseVersion(v), floorV) < 0)
      : versions.filter((v) => compare(parseVersion(v), floorV) !== 0);

    if (offenders.length > 0) {
      violations.push(
        ranged
          ? `\`${key}\`: ${offenders.map((v) => `\`${name}@${v}\``).join(", ")} still resolve(s) ` +
              `below the \`${floor}\` floor. The pin is written down but did not move the tree — ` +
              `regenerate the lockfile, or the key does not match what is actually installed.`
          : `\`${key}\`: pinned to \`${floor}\`, but the tree also resolves ` +
              `${offenders.map((v) => `\`${name}@${v}\``).join(", ")}. A bare override is supposed to ` +
              `collapse every copy onto one version.`,
      );
    }
  }

  return violations;
}

/**
 * Package names mentioned anywhere in the file's comments. Deliberately PERMISSIVE — it exists to
 * catch a pin added with no explanation at all, not to police how the explanation is written.
 */
export function collectDocumentedNames(text) {
  const names = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const hash = line.indexOf("#");
    if (hash === -1) continue;
    for (const m of line.slice(hash).matchAll(/(?:@[a-z0-9][\w.-]*\/)?[a-z][\w.-]*/gi)) {
      names.add(m[0]);
    }
  }
  return names;
}

/** @returns {Promise<{overrides: Record<string, string>, packages: string[], text: string}>} */
export async function readWorkspaceOverrides() {
  const text = await readFile(WORKSPACE_FILE, "utf8");
  const doc = parse(text);
  return {
    overrides: doc?.overrides ?? {},
    packages: Array.isArray(doc?.packages) ? doc.packages : [],
    text,
  };
}

/**
 * Every version each package actually resolves to, from the lockfile's `packages:` map.
 * Keys look like `name@version`, `@scope/name@version`, or `name@version(peer@1)(peer@2)`;
 * the descriptor may itself contain `@` (git+ssh, aliased `npm:`/`jsr:` specs).
 */
export async function readResolvedVersions() {
  const doc = parse(await readFile(LOCK_FILE, "utf8"));
  return readResolvedVersions.parseKeys(Object.keys(doc?.packages ?? {}));
}

/**
 * Exposed separately so the split is directly testable. The separator is the FIRST `@` of the
 * descriptor, not the last: a git+ssh or aliased descriptor (`undici@git+ssh://git@github…`)
 * contains its own `@`, and `lastIndexOf("@")` would land inside it — filing the copy under a
 * bogus name and silently dropping a possibly-vulnerable version from the package's list. For a
 * scoped name the separator is the `@` AFTER the scope's `/`; for a bare name it is the first `@`.
 */
readResolvedVersions.parseKeys = (keys) => {
  const resolved = new Map();
  for (const raw of keys) {
    const key = raw.replace(/\(.*$/, ""); // drop the peer-suffix
    const scoped = key.startsWith("@");
    const from = scoped ? key.indexOf("/") + 1 : 0;
    const at = scoped && from === 0 ? -1 : key.indexOf("@", from);
    if (at <= 0) continue; // a bare name, or a leading-@ scope with no `/version`
    const name = key.slice(0, at);
    const version = key.slice(at + 1);
    if (!resolved.has(name)) resolved.set(name, []);
    if (!resolved.get(name).includes(version)) resolved.get(name).push(version);
  }
  return resolved;
};

/**
 * Every directory the workspace's `packages:` globs point at, plus the root. Derived from the
 * globs rather than hardcoded so that adding a NEW top-level glob (`tooling/*`) automatically
 * widens the stranded-override sweep — a hardcoded list would leave the new tree silently
 * unswept, which is the exact #124 failure this guard exists to catch. Supports the two glob
 * shapes the workspace uses: a literal path, and `prefix/*` (immediate children); `**` descends.
 */
export async function workspacePackageDirs(globs) {
  const dirs = new Set(["."]);
  const walk = async (prefix, recursive) => {
    let entries;
    try {
      entries = await readdir(join(ROOT, prefix), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const child = join(prefix, e.name);
      dirs.add(child);
      if (recursive) await walk(child, true);
    }
  };
  for (const g of globs ?? []) {
    if (typeof g !== "string" || g.startsWith("!")) continue; // pnpm exclusion globs
    const star = g.indexOf("*");
    if (star === -1) {
      dirs.add(g.replace(/\/+$/, "") || ".");
      continue;
    }
    await walk(g.slice(0, star).replace(/\/+$/, ""), g.includes("**"));
  }
  return [...dirs];
}

/** package.json files that still carry the field pnpm 10 ignores. */
export async function findStrandedOverrides(dirs) {
  const found = [];
  for (const dir of dirs ?? ["."]) {
    const rel = dir === "." ? "package.json" : join(dir, "package.json");
    try {
      const pkg = JSON.parse(await readFile(join(ROOT, rel), "utf8"));
      if (pkg?.pnpm?.overrides && Object.keys(pkg.pnpm.overrides).length > 0) found.push(rel);
    } catch {
      /* no package.json here, or unreadable — not this guard's business */
    }
  }
  return found;
}

async function main() {
  const [{ overrides, packages, text }, resolved] = await Promise.all([
    readWorkspaceOverrides(),
    readResolvedVersions(),
  ]);
  const stranded = await findStrandedOverrides(await workspacePackageDirs(packages));
  const violations = overrideViolations({
    overrides,
    resolved,
    documented: collectDocumentedNames(text),
    stranded,
  });

  if (violations.length > 0) {
    console.error("✖ pnpm security overrides:\n");
    for (const v of violations) console.error(`  ${v}\n`);
    process.exit(1);
  }
  console.log(
    `✔ pnpm security overrides: all ${Object.keys(overrides).length} pin(s) in pnpm-workspace.yaml ` +
      `are documented and have moved the tree — no copy resolves below its floor across ` +
      `${resolved.size} packages in the lockfile. (Advisory DRIFT is Dependabot's job, not this guard's.)`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
