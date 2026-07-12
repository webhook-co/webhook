#!/usr/bin/env bash
# Apply pending prod migrations, then advance the `prod-schema` tag so the deploy migration-guard knows the
# schema is current. This is the ONE place that moves the tag — the guard trusts it as prod's applied-through
# marker (see .github/actions/migration-guard + scripts/migration-guard.mjs). Run it INSTEAD of a bare
# `dbmate up` whenever you apply migrations to prod.
#
# Prerequisites:
#   - A clean checkout at a commit that is on origin/main (the tagged sha must be a real, pushed main commit).
#   - DATABASE_URL set to the PROD webhook_owner connection (the non-pooler host; same as a manual dbmate up).
#   - Push access for the `prod-schema` tag (repo write).
#
# Recovery flow when the guard blocks an auto-deploy: run this (it applies the migration AND advances the
# tag), then push / re-run the deploy. The tag moves ONLY here, so a workflow_dispatch override can never
# silently blind the guard.
#
# Two ways to confirm the DB target (advancing prod-schema is trusted by the guard, so the target MUST be
# proven to be prod, not merely assumed):
#
#   1. INTERACTIVE (default): the operator types 'yes' at a TTY after eyeballing the host. A no-TTY run reads
#      an empty confirmation and aborts (fail-closed) — so a naive unattended run can never apply.
#
#   2. NON-INTERACTIVE (opt-in, for an automated/agent run): set APPLY_PROD_MIGRATIONS_ASSUME_YES=1 AND
#      MIGRATE_EXPECTED_DB_HOST=<the prod host>. The script then skips the prompt but HARD-ASSERTS the
#      resolved DATABASE_URL host equals MIGRATE_EXPECTED_DB_HOST — a machine check STRICTER than a human
#      eyeball: a mistyped/dev DATABASE_URL can't slip through, and it can't apply to the wrong DB even with
#      nobody watching. The expected host + the connection string live outside this (public) repo — in
#      scripts/.prod-migrate.env (gitignored), sourced below — so no prod specifics are ever committed.
set -euo pipefail

cd "$(dirname "$0")/.."

# Local, gitignored config for an unattended run (DATABASE_URL, MIGRATE_EXPECTED_DB_HOST,
# APPLY_PROD_MIGRATIONS_ASSUME_YES). Absent in a normal checkout → the interactive path is used. Never
# committed (see .gitignore) so no prod host/credential enters the public repo.
if [[ -f scripts/.prod-migrate.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source scripts/.prod-migrate.env
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is not set (point it at the PROD webhook_owner connection)." >&2
  exit 1
fi

# Refuse to tag a dirty tree — the tag must point at a real, pushed commit, not local WIP.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty. Commit/stash first so the tagged sha is reproducible." >&2
  exit 1
fi

SHA="$(git rev-parse HEAD)"

# The tag must point at a commit that is actually on origin/main (pushed + reviewed), else the guard would
# anchor prod-schema at an off-main/dangling commit. Fetch main and require HEAD to be an ancestor-or-equal.
git fetch -q origin main
if ! git merge-base --is-ancestor "$SHA" origin/main; then
  echo "error: HEAD ($SHA) is not on origin/main. Check out the main commit you intend to make live." >&2
  exit 1
fi

# The tag advances UNCONDITIONALLY after a successful apply, so the operator MUST confirm DATABASE_URL points
# at prod — applying to a dev/branch DB and then advancing the tag would blind the guard (prod left un-migrated
# while the guard believes it is current). Extract ONLY the host via a real URL parser (never echo the raw URL
# — its password must not hit logs); an unparseable URL prints a placeholder, not the connection string.
DB_HOST="$(DATABASE_URL="$DATABASE_URL" node -e 'try{process.stdout.write(new URL(process.env.DATABASE_URL).host||"(no host in URL)")}catch{process.stdout.write("(unparseable URL)")}')"
echo "About to run 'dbmate up' against host: ${DB_HOST}"
echo "…then advance the prod-schema tag to ${SHA}."

if [[ "${APPLY_PROD_MIGRATIONS_ASSUME_YES:-}" == "1" ]]; then
  # Non-interactive: prove the target is prod by an exact host match, not a human 'yes'. The expected host
  # MUST be provided (never defaulted) — an unset expectation aborts rather than assuming.
  if [[ -z "${MIGRATE_EXPECTED_DB_HOST:-}" ]]; then
    echo "error: APPLY_PROD_MIGRATIONS_ASSUME_YES=1 but MIGRATE_EXPECTED_DB_HOST is unset. Refusing to apply" >&2
    echo "       without a host to validate against (set it in scripts/.prod-migrate.env)." >&2
    exit 1
  fi
  if [[ "$DB_HOST" != "$MIGRATE_EXPECTED_DB_HOST" ]]; then
    echo "error: DATABASE_URL host ('${DB_HOST}') != MIGRATE_EXPECTED_DB_HOST ('${MIGRATE_EXPECTED_DB_HOST}')." >&2
    echo "       Refusing to apply — the target is not the expected prod database." >&2
    exit 1
  fi
  echo "Non-interactive confirm: host matches MIGRATE_EXPECTED_DB_HOST. Proceeding."
else
  read -r -p "Is that the PROD database? Type 'yes' to proceed: " CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "aborted (no changes made)." >&2
    exit 1
  fi
fi

echo "Applying pending migrations to prod (dbmate up)…"
pnpm --filter @webhook-co/db migrate:up

echo "Migrations applied. Advancing prod-schema -> ${SHA}"
# Lightweight tag (force-moved forward each apply) so the guard resolves it to a commit sha.
git push origin "${SHA}:refs/tags/prod-schema" --force

echo "Done. Auto-deploys are now allowed through ${SHA}."
