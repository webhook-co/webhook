#!/usr/bin/env node
// Fails if an internal dependency edge crosses the Node<->Workers tsconfig lib boundary
// without redirecting the dependency to its built `dist/*.d.ts`. This is wired into both the
// `lint` script and the `tsconfig-boundary` CI job.
//
// Why this exists: our packages export source (`exports: { ".": "./src/index.ts" }`) so editors
// get live cross-package types. But a Node-typed package (types: ["node"]) recompiling a
// Workers-typed dependency's source re-checks its WebCrypto (crypto.subtle.*) under node libs,
// where @types/node's Uint8Array<ArrayBufferLike> doesn't satisfy the DOM BufferSource — and the
// reverse (a Workers app recompiling db's node:crypto source) fails the same way. The fix is a
// convention: a cross-boundary internal edge resolves to the dep's emitted declarations, not its
// source. Same-world edges stay on source. This guard keeps that convention from silently
// regressing as new packages are added. See the engineering-conventions rule.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";

const ROOT = process.cwd();
const WORKSPACE_GLOBS = ["packages", "apps"];
const SCOPE = "@webhook-co/";

// Classify a tsconfig's lib-world from compilerOptions.types. Anything we can't classify is
// left "unknown" and skipped — the guard is a backstop, not a tripwire for false positives.
function libWorld(types) {
  if (!Array.isArray(types)) return "unknown";
  if (types.includes("@cloudflare/workers-types")) return "workers";
  if (types.includes("node")) return "node";
  return "unknown";
}

// Parse tsconfig JSONC (comments + trailing commas) via the TypeScript reader.
function readTsconfig(path) {
  const { config, error } = ts.readConfigFile(path, ts.sys.readFile);
  if (error) {
    const msg = ts.flattenDiagnosticMessageText(error.messageText, "\n");
    throw new Error(`Cannot parse ${relative(ROOT, path)}: ${msg}`);
  }
  return config ?? {};
}

// Does `paths` redirect `depName` to a dist *.d.ts? Accept an exact key or a `@scope/*` wildcard.
function redirectsToDist(paths, depName) {
  const targets = [];
  if (Array.isArray(paths[depName])) targets.push(...paths[depName]);
  for (const [key, value] of Object.entries(paths)) {
    if (!key.includes("*") || !Array.isArray(value)) continue;
    const [prefix, suffix] = key.split("*");
    if (depName.startsWith(prefix) && depName.endsWith(suffix)) targets.push(...value);
  }
  // A target lands in dist declarations, e.g. ../shared/dist/index.d.ts or ../*/dist/index.d.ts.
  // Swap any path wildcard for a literal non-separator char first, so a `../*/dist/...` mapping
  // still matches the `dist/*.d.ts` shape (the `*` itself isn't a real path segment).
  const WILDCARD_PLACEHOLDER = "x";
  return targets.some((t) => /(^|\/)dist\/.*\.d\.ts$/.test(t.replace(/\*/g, WILDCARD_PLACEHOLDER)));
}

// Discover workspace packages: a directory with both package.json and tsconfig.json.
const packages = [];
for (const glob of WORKSPACE_GLOBS) {
  const base = join(ROOT, glob);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    const pkgPath = join(dir, "package.json");
    const tsPath = join(dir, "tsconfig.json");
    if (!existsSync(pkgPath) || !existsSync(tsPath)) continue;

    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const co = readTsconfig(tsPath).compilerOptions ?? {};
    packages.push({
      name: pkg.name,
      tsPath,
      world: libWorld(co.types),
      paths: co.paths ?? {},
      deps: { ...pkg.dependencies, ...pkg.devDependencies },
    });
  }
}

const byName = new Map(packages.map((p) => [p.name, p]));
const violations = [];

for (const consumer of packages) {
  for (const depName of Object.keys(consumer.deps)) {
    if (!depName.startsWith(SCOPE)) continue;
    const dep = byName.get(depName);
    if (!dep) continue; // not an in-repo package we can classify
    if (consumer.world === "unknown" || dep.world === "unknown") continue; // conservative skip
    if (consumer.world === dep.world) continue; // same lib-world: source is correct (live types)
    if (!redirectsToDist(consumer.paths, depName)) {
      violations.push({ consumer, dep, depName });
    }
  }
}

if (violations.length > 0) {
  console.error("✖ Node<->Workers tsconfig boundary violations:\n");
  for (const { consumer, dep, depName } of violations) {
    console.error(`  ${consumer.name} (${consumer.world}) imports ${depName} (${dep.world})`);
    console.error(
      `    ${relative(ROOT, consumer.tsPath)} must redirect ${depName} to its built dist *.d.ts.`,
    );
    console.error(
      `    Add to compilerOptions.paths:  "${depName}": ["<rel>/dist/index.d.ts"]` +
        `  where <rel> is the relative path from this package to ${depName} (e.g. "../shared" or "../db"),` +
        `  or use "@webhook-co/*": ["<rel>/*/dist/index.d.ts"] when every internal dep crosses.\n`,
    );
  }
  console.error("A node-typed package recompiling a workers-typed dep's source (or vice versa)");
  console.error("re-checks WebCrypto/node:crypto across the lib boundary and fails to typecheck.");
  console.error("See the engineering-conventions rule.");
  process.exit(1);
}

console.log(
  "✔ tsconfig node<->workers boundary: every cross-boundary internal dep redirects to dist.",
);
