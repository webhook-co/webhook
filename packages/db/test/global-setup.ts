// Vitest globalSetup for the DB integration suites. Its only job is to PRE-WARM a
// remote managed engine (the nightly Neon branch) before any suite runs, so a suspended
// compute's cold-start latency is spent HERE (untimed) rather than inside a suite's
// beforeAll/connect budget — the cause of the intermittent `CONNECT_TIMEOUT` on the
// heaviest (RLS) suite. It is a no-op for the local ephemeral cluster and trust-auth CI
// service (nothing to wake), so it never slows the fast local/CI lanes.

import postgres from "postgres";

import { assertExpectedTestDatabaseHost } from "./expected-host";
import { isRemoteTestDatabase, orphanTestDatabases, waitForDatabase } from "./pg-timing";

export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  // BEFORE the sweep below, which is an unconditional `DROP DATABASE … WITH (FORCE)`. globalSetup
  // runs ahead of every suite, so this — not startEphemeralPostgres — is the FIRST thing that can
  // damage a mis-pointed cluster. A no-op for the local/trust-auth lanes. (R6 pins the ordering.)
  assertExpectedTestDatabaseHost(url);
  if (!isRemoteTestDatabase(url)) return;

  // Short per-probe connect budget so a cold connection fails fast and we retry, instead
  // of blocking on postgres.js's 30s default for a compute that is still spinning up.
  const sql = postgres(url as string, {
    max: 1,
    prepare: false,
    fetch_types: false,
    connect_timeout: 15,
    idle_timeout: 1,
  });
  try {
    await waitForDatabase({
      probe: async () => {
        await sql`select 1`;
      },
      attempts: 20,
      delayMs: 3_000,
      onRetry: ({ attempt, attempts }) =>
        console.log(
          `[nightly-rls] waiting for the managed compute to wake (${attempt}/${attempts})`,
        ),
    });
    console.log("[nightly-rls] managed compute is awake; starting suites");

    // Sweep test databases orphaned by a crashed/cancelled/timed-out prior run. Roles are
    // cluster-global on the shared compute, so an orphan's grants/policies still pin them
    // and can block this run's migration-down DROP ROLE. The concurrency group serializes
    // nightly runs and this run's own per-file databases are created later, so every match
    // here is stale. Best-effort: a drop that races another connection must not fail setup.
    const [{ current }] = await sql<{ current: string }[]>`select current_database() as current`;
    const rows = await sql<{ datname: string }[]>`select datname from pg_database`;
    for (const datname of orphanTestDatabases(
      rows.map((r) => r.datname),
      current,
    )) {
      try {
        await sql.unsafe(`drop database if exists "${datname}" with (force)`);
        console.log(`[nightly-rls] dropped orphaned test database ${datname}`);
      } catch (error) {
        console.log(`[nightly-rls] could not drop orphaned ${datname}: ${String(error)}`);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
