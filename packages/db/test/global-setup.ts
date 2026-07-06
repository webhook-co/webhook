// Vitest globalSetup for the DB integration suites. Its only job is to PRE-WARM a
// remote managed engine (the nightly Neon branch) before any suite runs, so a suspended
// compute's cold-start latency is spent HERE (untimed) rather than inside a suite's
// beforeAll/connect budget — the cause of the intermittent `CONNECT_TIMEOUT` on the
// heaviest (RLS) suite. It is a no-op for the local ephemeral cluster and trust-auth CI
// service (nothing to wake), so it never slows the fast local/CI lanes.

import postgres from "postgres";

import { isRemoteTestDatabase, waitForDatabase } from "./pg-timing";

export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
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
  } finally {
    await sql.end({ timeout: 5 });
  }
}
