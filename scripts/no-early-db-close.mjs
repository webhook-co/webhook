#!/usr/bin/env node
// Fails if anything in apps/web CLOSES the tenant Postgres client. Only `src/server/db.ts` may, and only via
// Next's `after()`. Wired into the `lint` script.
//
// ── Why this is a guard and not a comment ────────────────────────────────────────────────────────────────
//
// The dashboard used to open a NEW client per loader (`createClient(..., { max: 1 })`) and close it in a
// `finally`. Six connections to render the overview page. It now opens ONE per render, shared by every loader,
// and closes it ONCE — from `after()`, which runs AFTER the response.
//
// That inverts an invariant, silently. `await app.end()` in a loader used to be not just correct but
// MANDATORY — a leaked connection on Workers is what exhausts the pool. It is now a BUG, and a nasty one: the
// first loader to finish would close the client out from under every other loader still using it, and the page
// 500s with `write CONNECTION_ENDED` mid-render. The shape that is wrong is the shape that was right for the
// whole life of this codebase, and it is still what a reasonable contributor would write from memory.
//
// A comment cannot defend that. Neither can a unit test per call site: there were SIX places doing this, the
// tests inject their own deps (so the real provider is never exercised), and the seventh place someone adds
// tomorrow would have no test at all. So the rule is enforced statically, over the whole directory, where a
// new call site cannot slip past it by simply not having been thought of.
//
// The single legal close lives in `src/server/db.ts` and is registered with `after()`. If you genuinely need
// another, you are almost certainly wrong — but the exemption is `// db-close-allow: <reason>` on the line, so
// it must be argued for in the diff rather than added by accident.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SERVER_DIR = join(ROOT, "apps/web/src/server");
/** The one module that owns the client's lifecycle. */
const OWNER = "db.ts";
const ALLOW = "db-close-allow:";

/** `app.end(`, `sql.end(`, `client.end(` … — any `.end(` on a postgres.js client. */
const CLOSE_RE = /\.end\s*\(/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const violations = [];

for (const file of walk(SERVER_DIR)) {
  const name = file.split("/").pop();
  // The owner may close. Tests may assert ON closing (they mock the client and count `end` calls) — asserting
  // that something is NOT closed is the whole point of some of them, so they cannot be forbidden from naming it.
  if (name === OWNER || /\.test\.tsx?$/.test(name)) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!CLOSE_RE.test(line)) return;
    if (line.includes(ALLOW)) return;
    // Ignore unrelated `.end(` on non-clients (e.g. a string/array method). Only flag when the receiver looks
    // like a db client — that is what every real instance of this bug looks like.
    if (!/\b(app|sql|client|db|tx)\s*\.end\s*\(/.test(line)) return;
    violations.push(`${relative(ROOT, file)}:${i + 1}\n    ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error(
    "\n✖ no-early-db-close: something is closing the tenant Postgres client.\n\n" +
      "  The client is SHARED across the whole render now and is closed exactly once, from `after()`, in\n" +
      "  apps/web/src/server/db.ts — AFTER the response. Closing it from a loader or a server action pulls the\n" +
      "  connection out from under every other loader still using it, and the page 500s mid-render.\n\n" +
      "  This used to be the correct — and required — thing to do, which is exactly why it is guarded.\n\n" +
      "  Use `withTenantDb(fn)` / `getTenantDb()` and simply do not close what you did not open.\n",
  );
  for (const v of violations) console.error(`  ${v}\n`);
  process.exit(1);
}

console.log(
  "✔ no-early-db-close: the tenant client is closed in exactly one place (db.ts, via after()).",
);
