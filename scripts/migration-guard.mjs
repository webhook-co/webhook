// Deploy-time migration guard — the TESTED brain of the "auto-deploy must not outrun a manual migration"
// check shared by the three prod deploy workflows (deploy.yml / deploy-web.yml / deploy-auth.yml).
//
// WHY: migrations are applied MANUALLY (dbmate up as webhook_owner), decoupled from CD. If code that depends
// on a new schema deploys before the migration is applied, it runs against an un-migrated prod DB. The guard
// blocks the AUTO deploy for such a change and requires the operator to apply the migration first.
//
// THE MARKER: a single, global lightweight git tag `prod-schema` points at the commit whose migrations are
// all applied to prod. It is advanced ONLY by the migration-apply step (scripts/apply-prod-migrations.sh),
// so it is a truthful record of prod's schema state — unlike deploy-success, which says nothing about whether
// a migration was applied. One global tag ⇒ a migration blocks ALL apps until applied (no per-app wedging),
// and a workflow_dispatch override does not move the tag (so it can never blind the guard).
//
// WHAT WE COMPARE: the SET of migration files present at HEAD vs at prod-schema — NOT a commit-range diff.
// The tag moves only on apply, so `prod-schema...HEAD` can span far more than GitHub's 250-commit / 300-file
// compare limits between migrations, which would truncate the diff (hiding an added migration ⇒ fail open, or
// tripping the file cap ⇒ over-block every routine deploy). Listing just the migrations directory at each ref
// is bounded (~one entry per migration) and immune to both limits.
//
// The IO (list the migrations dir at each ref, set the step output) lives in the migration-guard composite
// action; the pure decision below lives here so it is unit-tested (scripts/migration-guard.test.mjs) in one
// place and can't drift between workflows.

/** A numbered migration FILENAME: `<digits>_<name>.sql`. Mirrors packages/db/test/migrate.ts — the leading
 *  `\d+_` rule excludes the `.better-auth.schema.sql` dump and `.gitkeep` that also live under the dir. */
export const MIGRATION_FILE_RE = /^\d+_.*\.sql$/;

/** @param {unknown} name @returns {boolean} */
export function isMigrationName(name) {
  return typeof name === "string" && MIGRATION_FILE_RE.test(name);
}

/**
 * A migration dir entry: its filename + git blob sha (from getContent). We compare on (name, sha) — not name
 * alone — so an IN-PLACE EDIT to an already-applied migration (same filename, different content ⇒ different
 * blob sha) is caught too. dbmate keys on the numeric version, so it would SKIP an edited-but-recorded
 * migration, leaving prod without the new DDL; keying on the blob sha blocks that (a migration file must be
 * immutable once applied — add a new migration instead).
 * @typedef {{ name: string, sha: string }} MigrationEntry
 */

/**
 * Numbered migration filenames present at HEAD that are absent OR changed (different blob sha) relative to
 * base (prod-schema) — i.e. not applied to prod as-is. Junk entries are ignored (never thrown).
 * @param {unknown} baseEntries - {@link MigrationEntry}[] at prod-schema
 * @param {unknown} headEntries - {@link MigrationEntry}[] at HEAD
 * @returns {string[]}
 */
export function unappliedMigrations(baseEntries, headEntries) {
  const baseSha = new Map();
  for (const e of Array.isArray(baseEntries) ? baseEntries : []) {
    if (e && isMigrationName(e.name) && typeof e.sha === "string") baseSha.set(e.name, e.sha);
  }
  const out = [];
  for (const e of Array.isArray(headEntries) ? headEntries : []) {
    if (!e || !isMigrationName(e.name)) continue;
    // Applied-as-is ONLY when base has this exact name with a real, matching blob sha. A missing/non-string
    // head sha, an absent base entry (new file), or a differing sha (in-place edit) all count as unapplied —
    // symmetric with the base guard above, and FAIL CLOSED on a malformed entry.
    const headSha = typeof e.sha === "string" ? e.sha : null;
    if (headSha === null || baseSha.get(e.name) !== headSha) out.push(e.name);
  }
  return out;
}

/**
 * Decide whether to block, from the migration-dir listings at base (prod-schema) and head (HEAD). FAIL CLOSED
 * when either listing is unusable (couldn't enumerate the dir ⇒ we can't prove the schema is current).
 * @param {unknown} baseEntries @param {unknown} headEntries
 * @returns {{ blocked: boolean, reason: string, migrations: string[] }}
 */
export function guardDecision(baseEntries, headEntries) {
  if (!Array.isArray(baseEntries) || !Array.isArray(headEntries)) {
    return { blocked: true, reason: "inconclusive-listing", migrations: [] };
  }
  const migrations = unappliedMigrations(baseEntries, headEntries);
  return migrations.length > 0
    ? { blocked: true, reason: "migration-not-applied", migrations }
    : { blocked: false, reason: "no-migration", migrations: [] };
}
