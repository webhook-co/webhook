#!/usr/bin/env node
// memberships org-scope guard (Lane 2.4).
//
// Migration 0067 adds a PERMISSIVE `memberships_self_select` policy (`user_id = current_app_user()`), which
// is what makes "which orgs do I belong to?" answerable at all. Postgres policies OR together, so from that
// migration onward ANY `memberships` query that does not name `org_id` explicitly is silently CROSS-ORG.
//
// That is not hypothetical. Three such queries existed and were fixed in Lane S.4 — `select role from
// memberships where user_id = $1 limit 1`, with no org_id and no ORDER BY. Under the new policy that returns
// an ARBITRARY row: a user who is a plain `member` of a team but `owner` of their own personal org reads
// back `owner` and passes an owner/admin gate ON THE TEAM. A real privilege escalation, opened by a policy
// that looks purely additive.
//
// So the invariant gets a lock, not a comment: every SQL statement touching `memberships` must either
//   (a) name `org_id` explicitly, or
//   (b) be deliberately user-scoped and say so with an `rls-scope: user` marker on a nearby line.
//
// The ONE legitimate (b) today is listUserOrgs — the read the whole multi-org lane is built on.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIRS = [join(ROOT, "packages/db/src")];

/** A deliberate user-scoped read must carry this marker within a few lines above the statement. */
const USER_SCOPE_MARKER = "rls-scope: user";

/**
 * Blank out comments, PRESERVING line numbers. Comments in this codebase are full of markdown backticks
 * (`memberships` is scoped `org_id = ...`), and a naive template scanner reads those as template literals —
 * which made the guard's first run report a false positive against a query that was in fact perfectly
 * org-qualified. Only real code is scanned.
 */
function stripComments(text) {
  return text
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
    .join("\n");
}

/** Extract every backtick-delimited template literal, with the line it starts on. */
function templates(text) {
  const out = [];
  const lines = text.split("\n");
  let buf = null;
  lines.forEach((line, i) => {
    if (buf === null) {
      const open = line.indexOf("`");
      if (open === -1) return;
      buf = { startLine: i + 1, text: line.slice(open + 1) };
      // A single-line template closes on the same line.
      const close = buf.text.indexOf("`");
      if (close !== -1) {
        buf.text = buf.text.slice(0, close);
        out.push(buf);
        buf = null;
      }
      return;
    }
    const close = line.indexOf("`");
    if (close === -1) {
      buf.text += `\n${line}`;
      return;
    }
    buf.text += `\n${line.slice(0, close)}`;
    out.push(buf);
    buf = null;
  });
  return out;
}

const failures = [];

for (const dir of SRC_DIRS) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const path = join(dir, file);
    const raw = readFileSync(path, "utf8");
    if (!raw.includes("memberships")) continue;
    const text = stripComments(raw);
    const lines = raw.split("\n"); // the marker lives in a COMMENT, so look for it in the raw text

    for (const tpl of templates(text)) {
      // Only READS are at risk. Migration 0067 adds a `for select` policy; INSERT (WITH CHECK) and
      // UPDATE/DELETE (USING) on memberships are still governed solely by `org_id = current_org_id()` and
      // are unchanged. So police `from memberships` / `join memberships`, not `insert into memberships`.
      if (!/\b(from|join)\s+memberships\b/.test(tpl.text)) continue;
      // (a) org-qualified. Require org_id to be CONSTRAINED (`org_id = …`), not merely mentioned —
      // `select org_id from memberships where user_id = $1` names the column while being exactly the
      // cross-org read this guard exists to stop.
      if (/\borg_id\s*=/.test(tpl.text)) continue;

      // (b) deliberately user-scoped? Look for the marker in the 6 lines above the statement.
      const from = Math.max(0, tpl.startLine - 7);
      const preamble = lines.slice(from, tpl.startLine).join("\n");
      if (preamble.includes(USER_SCOPE_MARKER)) continue;

      failures.push(
        `${path.replace(`${ROOT}/`, "")}:${tpl.startLine} — a \`memberships\` query with no org_id predicate.\n` +
          `    Since migration 0067 (memberships_self_select) policies OR together, so this is CROSS-ORG.\n` +
          `    Add an explicit \`org_id = \${...}\` predicate, or — if it is deliberately user-scoped —\n` +
          `    annotate it with a "${USER_SCOPE_MARKER}" comment above the statement.`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("memberships-org-scope-guard: FAILED\n");
  for (const f of failures) console.error(`  ${f}\n`);
  process.exit(1);
}

console.log(
  "memberships-org-scope-guard: every memberships query is org-scoped (or explicitly user-scoped).",
);
