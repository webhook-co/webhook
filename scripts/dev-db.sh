#!/usr/bin/env bash
# Bring up the LOCAL dev Postgres that `wrangler dev` expects.
#
# Every Hyperdrive binding's `localConnectionString` points at 127.0.0.1:5432/webhook_dev as a specific
# role (webhook_billing, webhook_app, …), but nothing in the repo ever created that cluster — the test
# suite spins its own throwaway one on a random port (packages/db/test/pg.ts) and tears it down. So
# `wrangler dev` had no database to talk to. This is that missing piece.
#
# Docker-free (there is no container runtime here): a durable cluster under .dev-pg/ via the Homebrew
# initdb/pg_ctl, `trust` auth — same call the test harness makes. Trust auth is why the placeholder
# `:postgres` password in the wrangler strings works: the roles are created `login` with NO password,
# so the cluster must not ask for one. A LOCAL, loopback-only, throwaway cluster; never a prod pattern.
#
# Idempotent: safe to re-run. `stop` halts it, `nuke` deletes the cluster entirely.
#
#   scripts/dev-db.sh          # create (if needed), start, migrate
#   scripts/dev-db.sh stop
#   scripts/dev-db.sh nuke

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
PGDATA="$ROOT/.dev-pg"
LOGFILE="$PGDATA/postgres.log"

# PG17, matching CI (`postgres:17`), the test harness's floor, and both Neon projects. The version is
# not cosmetic: the harness models the managed engine's NON-SUPERUSER provider role, which needs PG16+
# role-membership semantics — see MIN_SERVER_MAJOR in packages/db/test/pg.ts.
PG_MAJOR=17
PG_BIN="$(brew --prefix postgresql@$PG_MAJOR 2>/dev/null)/bin"
[ -x "$PG_BIN/initdb" ] || { echo "❌ postgresql@$PG_MAJOR not found. brew install postgresql@$PG_MAJOR" >&2; exit 1; }
command -v dbmate >/dev/null || { echo "❌ dbmate not found. brew install dbmate" >&2; exit 1; }

# The dev cluster's shape is DERIVED from the wrangler configs, never restated — see dev-db-config.mjs.
# That module THROWS when the bindings disagree (two different dev databases/ports = a half-provisioned
# cluster). Assign first and check, rather than `eval "$(...)"`: eval discards the child's exit status, so
# a thrown config error degraded into a bare `SUPERUSER: unbound variable` and the real message was lost.
if ! CONFIG="$(node -e '
import("./scripts/dev-db-config.mjs").then(async (m) => {
  const fs = await import("node:fs");
  const texts = fs.readdirSync("apps").map((d) => {
    try { return fs.readFileSync(`apps/${d}/wrangler.jsonc`, "utf8"); } catch { return ""; }
  });
  const c = m.parseDevDbConfig(texts);
  console.log(`PORT=${c.port}; DB=${c.database}; SUPERUSER=${c.superuser}; ROLES="${c.roles.join(" ")}"`);
}).catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
')"; then
  echo "❌ could not derive the dev-DB shape from the wrangler configs (see above)" >&2
  exit 1
fi
eval "$CONFIG"

SUPER_URL="postgres://${SUPERUSER}@127.0.0.1:${PORT}/${DB}?sslmode=disable"

is_running() { "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; }

case "${1:-up}" in
  stop)
    is_running && "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null && echo "🛑 stopped" || echo "already stopped"
    exit 0
    ;;
  nuke)
    is_running && "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null || true
    rm -rf "$PGDATA"
    echo "💥 cluster deleted ($PGDATA)"
    exit 0
    ;;
  up) ;;
  *) echo "usage: scripts/dev-db.sh [up|stop|nuke]" >&2; exit 2 ;;
esac

# A datadir is bound to the major that created it. Since we skip initdb whenever .dev-pg exists, a
# cluster built by an older pin (PG14, before #734) would be started with PG17 binaries and die on a
# bare `FATAL: database files are incompatible with server` — true, and useless, because the fix
# DELETES the cluster and nobody would guess it. Decide in dev-db-preflight.mjs, where it is tested;
# report here. Deliberately AFTER the case block, so `nuke` — the remedy — is never blocked by it.
if ! node -e '
import("./scripts/dev-db-preflight.mjs").then((m) => {
  const fault = m.datadirVersionFault({
    datadirVersion: m.readDatadirVersion(process.argv[1]),
    expectedMajor: process.argv[2],
  });
  if (fault) {
    console.error(`❌ ${fault.message}`);
    process.exit(1);
  }
}).catch((err) => {
  console.error(`❌ ${err.message}`);
  process.exit(1);
});
' "$PGDATA" "$PG_MAJOR"; then
  exit 1
fi

if [ ! -d "$PGDATA" ]; then
  echo "🔧 initdb → $PGDATA (trust auth, loopback only)"
  "$PG_BIN/initdb" -D "$PGDATA" -U "$SUPERUSER" --auth=trust >/dev/null
fi

if is_running; then
  echo "✅ cluster already running on :$PORT"
else
  echo "🚀 starting cluster on :$PORT"
  # -h 127.0.0.1 binds loopback only: this trust-auth cluster must never be reachable off-box.
  "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$LOGFILE" -o "-p $PORT -h 127.0.0.1" -w start >/dev/null
fi

if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$SUPERUSER" -lqt postgres | cut -d'|' -f1 | grep -qw "$DB"; then
  echo "📦 createdb $DB"
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -U "$SUPERUSER" "$DB"
fi

# Migrations run as a NON-SUPERUSER `webhook_owner`, exactly as in prod (packages/db/test/migrate.ts):
# it owns every table, so FORCE RLS still polices it. Running them as the superuser instead would let
# a policy bug pass locally and only surface in prod. CREATEROLE is what lets the migrations create the
# app roles. Idempotent — the role is cluster-global and may already exist.
echo "👤 bootstrap schema owner (webhook_owner)"
"$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$SUPERUSER" -d "$DB" -v ON_ERROR_STOP=1 -q <<SQL
do \$\$
begin
  if not exists (select 1 from pg_roles where rolname = 'webhook_owner') then
    create role webhook_owner login createrole nosuperuser nobypassrls;
  end if;
end
\$\$;
grant all on database "$DB" to webhook_owner;
grant all on schema public to webhook_owner;
SQL

echo "⬆️  dbmate up (creates the schema AND the app roles)"
OWNER_URL="postgres://webhook_owner@127.0.0.1:${PORT}/${DB}?sslmode=disable"
DATABASE_URL="$OWNER_URL" dbmate --no-dump-schema --migrations-dir packages/db/db/migrations up

# The wrangler bindings connect as these roles. If a migration ever stops creating one, `wrangler dev`
# fails deep inside a Worker with an opaque auth error — so check here, where the message can be clear.
missing=""
for role in $ROLES; do
  "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U "$SUPERUSER" -d "$DB" -tAc \
    "select 1 from pg_roles where rolname='$role' and rolcanlogin" | grep -q 1 || missing="$missing $role"
done
if [ -n "$missing" ]; then
  echo "❌ the wrangler bindings need these login roles, but the migrations did not create them:$missing" >&2
  exit 1
fi

echo
echo "✅ dev DB ready — $SUPER_URL"
echo "   roles verified:$(printf ' %s' $ROLES)"
echo "   logs: $LOGFILE   ·   stop: scripts/dev-db.sh stop"
echo
# docs/local-billing-sandbox.md tells you to run `psql "$DEV_DB"`, but nothing ever defined DEV_DB —
# it appeared in that one line and nowhere else in the repo, so the documented command could not work.
# A child process cannot export into your shell, so emit the assignment for the reader to copy.
echo "   to open a psql session against it:"
echo "     export DEV_DB='$SUPER_URL'"
echo "     psql \"\$DEV_DB\""
