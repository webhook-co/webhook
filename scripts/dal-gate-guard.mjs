#!/usr/bin/env node
// Fails if any server entry point in apps/web (the app. dashboard) can reach tenant data without the
// Data-Access-Layer gate. The dashboard is private (ADR-0023). Wired into the `lint` script and the
// `dal-gate-guard` CI job.
//
// What it enforces — four classes of server entry point:
//   1. "use server" modules (server actions) — invoked directly from anywhere, bypassing any
//      layout; each must call a gate or carry a `// dal-gate-allow:` marker.
//   2. route handlers (route.ts) — invoked directly; same rule.
//   3. page / layout / default / template server components INSIDE the gated `(app)/` group — each must
//      call `requireOrgAccess()` (ADR-0116). The `(app)/layout.tsx` render gate is necessary but NOT
//      sufficient: Next renders a layout and its page CONCURRENTLY, so the layout's refusal does not
//      prevent the page's tenant query from having already run. Every page gates for itself.
//   4. the same, OUTSIDE `(app)/` — not render-gated, so each must gate itself or be allow-marked.
//
// Exempt a path with `// dal-gate-allow: <reason>` ONLY when it owns no tenant data: the html
// shell layout, session-management (logout), dev/pre-auth bootstrap (mints no identity), and pure
// redirect stubs.
//
// Known limitations (grep-level, not a type-checker): it verifies a gate call is PRESENT, not that it
// runs first/unconditionally on every branch; metadata routes (sitemap/opengraph-image) aren't
// classified as entries. Don't lean on it to excuse an ungated branch — gate the path.
//
// NON-NEGOTIABLE (AGENTS.md / ADR-0023): don't remove the gate or hand out allow markers to
// silence this.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const APP_WEB_SRC = join(ROOT, "apps/web/src");
const APP_DIR = "apps/web/src/app/";
const GATED_GROUP = "apps/web/src/app/(app)/org/[slug]/";
const RENDER_GATE = "apps/web/src/app/(app)/org/[slug]/layout.tsx";

// Match an actual CALL to a DAL gate, after stripping comments — so a disabled/commented call or a
// `{@link …}` mention doesn't count as gating the path.
//
// TWO gates, and they are NOT interchangeable:
//
//   verifySession()    proves IDENTITY. It says the cookie is validly signed and un-expired. It says
//                      NOTHING about whether the caller still belongs to the org the cookie names.
//   requireOrgAccess() proves identity AND CURRENT MEMBERSHIP, re-read from the database this request.
//
// The session is stateless — a signed cookie, 7-day TTL, no revocation store — so the org it names is a
// claim made at mint time that nothing else ever re-checks. `verifySession` alone therefore trusts that
// claim forever, and RLS does not save you: RLS proves a query was scoped to the org the query NAMED, not
// that the caller belongs to it.
//
// That is not hypothetical. Every page under `(app)/` and the render gate itself used `verifySession` alone,
// and the read surface consequently served a removed member their ex-org's endpoints, events and webhook
// payloads for the remaining life of their cookie. The e2e suite caught it; this guard is what stops it
// coming back. Inside `(app)/`, only `requireOrgAccess` counts.
const GATE_CALL = /\b(?:verifySession|requireOrgAccess)\s*\(/;
// Note the `[^)\s]`: the call must pass an ARGUMENT. Since the URL move, `requireOrgAccess()` with no slug is
// a type error — but a guard that accepts it would still be lying, and the whole point of this file is that it
// does not depend on someone else's type checker having run. The org comes from the URL; a gate that is not
// told which org it is gating is not gating anything.
const ORG_GATE_CALL = /\brequireOrgAccess\s*\(\s*[^)\s]/;
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
    if (!ORG_GATE_CALL.test(stripComments(src))) {
      violations.push(
        `${rel}  (render gate)  does not call requireOrgAccess() — verifySession() proves identity, not membership`,
      );
    }
    continue;
  }

  const isUseServer = USE_SERVER.test(src);
  const isRoute = ROUTE_FILE.test(rel);
  // page/layout/default/template under app/, OUTSIDE the gated group, is not render-gated.
  const isUngatedPageLike =
    PAGE_LIKE.test(rel) && rel.startsWith(APP_DIR) && !rel.startsWith(GATED_GROUP);

  // INSIDE the gated group, EVERY server entry point must prove membership — pages AND route handlers.
  //
  // Two reasons this is not just the layout's job. First, the render gate is necessary but not sufficient:
  // Next renders a layout and its page CONCURRENTLY, so the layout's refusal does not prevent the page's
  // tenant query from having already run. Second, a route handler has no layout above it at ALL — and the one
  // route handler in this tree, `endpoints/[id]/events/[eventId]/payload/route.ts`, streams an event's raw
  // captured webhook body out of R2. It is the single most sensitive read in the app, and it is a `route.ts`,
  // so a page-only rule would leave precisely it able to regress to identity-only gating with CI still green.
  //
  // `requireOrgAccess` is memoized per request (React `cache`), so this costs one membership read for a whole
  // render, not one per component. (In a route handler or an action there is no RSC request in scope, so
  // `cache` calls straight through — no memoization, and no possibility of a stale or foreign result either.)
  const isGatedEntry = rel.startsWith(GATED_GROUP) && (PAGE_LIKE.test(rel) || isRoute);

  if (isGatedEntry) {
    if (!ORG_GATE_CALL.test(stripComments(src)) && !ALLOW_MARKER.test(src)) {
      const kind = isRoute ? "gated route handler" : "gated server component";
      violations.push(
        `${rel}  (${kind})  does not call requireOrgAccess() and has no \`// dal-gate-allow:\` marker`,
      );
    }
    continue;
  }

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
  console.error("✖ Ungated app. data paths (ADR-0023):\n");
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nGate it first-line — requireOrgAccess() inside (app)/, verifySession() elsewhere — or add\n" +
      "`// dal-gate-allow: <reason>` only if the path owns no tenant data.",
  );
  process.exit(1);
}

console.log(
  "✔ DAL gate: every app. server entry point is gated (membership-checked inside (app)/).",
);
