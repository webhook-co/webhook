#!/usr/bin/env node
// Fails if any server entry point in apps/web (the app. dashboard) can reach tenant data
// without the Data-Access-Layer gate (verifySession). The dashboard is private (ADR-0023).
// Wired into the `lint` script and the `dal-gate-guard` CI job.
//
// What it enforces — three classes of server entry point:
//   1. "use server" modules (server actions) — invoked directly from anywhere, bypassing any
//      layout; each must call verifySession() or carry a `// dal-gate-allow:` marker.
//   2. route handlers (route.ts) — invoked directly; same rule.
//   3. page / layout / default / template server components under app/ — these render request
//      output. Anything UNDER the gated `(app)/` group is covered by `(app)/layout.tsx` (the
//      render gate, which is asserted to call verifySession). Anything OUTSIDE `(app)/` is not
//      render-gated, so it must call verifySession() itself or be allow-marked.
//
// Exempt a path with `// dal-gate-allow: <reason>` ONLY when it owns no tenant data: the html
// shell layout, session-management (logout), and dev/pre-auth bootstrap (mints no identity).
//
// Known limitations (grep-level, not a type-checker): it verifies a verifySession() call is
// PRESENT, not that it runs first/unconditionally on every branch; metadata routes
// (sitemap/opengraph-image) aren't classified as entries. Don't lean on it to excuse an
// ungated branch — gate the path.
//
// NON-NEGOTIABLE (AGENTS.md / ADR-0023): don't remove the gate or hand out allow markers to
// silence this.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const APP_WEB_SRC = join(ROOT, "apps/web/src");
const APP_DIR = "apps/web/src/app/";
const GATED_GROUP = "apps/web/src/app/(app)/";
const RENDER_GATE = "apps/web/src/app/(app)/layout.tsx";

// Match an actual CALL (`verifySession(`), after stripping comments — so a disabled/commented
// call or a `{@link …}` mention doesn't count as gating the path.
const GATE_CALL = /\bverifySession\s*\(/;
const ALLOW_MARKER = /\/\/\s*dal-gate-allow:/;

const ROUTE_FILE = /(?:^|\/)route\.[cm]?[jt]sx?$/;
const PAGE_LIKE = /(?:^|\/)(?:page|layout|default|template)\.[cm]?[jt]sx?$/;
const USE_SERVER = /^\s*["']use server["'];?\s*$/m;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(test|spec)\./;
const IGNORED_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", "build", ".wrangler"]);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?<!:)\/\/.*$/gm, "");

const gated = (src) => GATE_CALL.test(stripComments(src)) || ALLOW_MARKER.test(src);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return; // dir doesn't exist yet
    throw err; // surface permission/IO errors rather than silently passing
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const violations = [];
let sawRenderGate = false;

for await (const file of walk(APP_WEB_SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const src = await readFile(file, "utf8");

  if (rel === RENDER_GATE) {
    sawRenderGate = true;
    if (!GATE_CALL.test(stripComments(src))) {
      violations.push(`${rel}  (render gate)  does not call verifySession()`);
    }
    continue;
  }

  const isUseServer = USE_SERVER.test(src);
  const isRoute = ROUTE_FILE.test(rel);
  // page/layout/default/template under app/, OUTSIDE the gated group, is not render-gated.
  const isUngatedPageLike =
    PAGE_LIKE.test(rel) && rel.startsWith(APP_DIR) && !rel.startsWith(GATED_GROUP);

  let kind = null;
  if (isUseServer) kind = "server action";
  else if (isRoute) kind = "route handler";
  else if (isUngatedPageLike) kind = "ungated server component";
  if (!kind) continue;

  if (!gated(src)) {
    violations.push(
      `${rel}  (${kind})  does not call verifySession() and has no \`// dal-gate-allow:\` marker`,
    );
  }
}

if (!sawRenderGate) {
  violations.push(`${RENDER_GATE}  is missing — the (app) render gate must exist`);
}

if (violations.length > 0) {
  console.error("✖ Ungated app. data paths — each must call verifySession() (ADR-0023):\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nGate it (call verifySession() first-line), or add `// dal-gate-allow: <reason>` only if " +
      "the path owns no tenant data.",
  );
  process.exit(1);
}

console.log("✔ DAL gate: every app. server entry point verifies the session.");
