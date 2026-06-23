// The cross-org expiry cron-sweep glue (ADR-0055). A daily scheduled() trigger prunes EXPIRED rows from the
// two short-lived auth-handle tables (auth_refresh_token 0017, auth_session_exchange 0019) across EVERY org.
//
// It connects as the least-privilege **webhook_sweeper** role over HYPERDRIVE_SWEEPER — a DELETE-only,
// non-bypass role whose role-targeted `USING (expires_at < now())` policy is the only gate, so pruneAll's
// bare deletes can only ever remove already-expired rows and the role can read NO row data. This covers the
// fully-churned / abandoned orgs the on-access per-org sweep (which only touches the consuming org) misses.
//
// worker.ts (tsc-excluded for its generated-handler import) calls runAuthExpirySweep from a thin
// scheduled(), mirroring how IssuerIntrospect delegates to introspect — so the real logic stays in this
// type-checked + tested module. I/O glue only (one pool + a count log); errors are logged, never thrown
// (a cron failure must not surface as an uncaught rejection in the scheduled handler).

import { createClient, pruneAllExpiredAuthTokens } from "@webhook-co/db";

import { readSweepEnv, type SweepEnv } from "./env";

/**
 * Run one cross-org expiry sweep. Opens a webhook_sweeper-scoped postgres.js client over HYPERDRIVE_SWEEPER,
 * prunes expired refresh + session-exchange rows across all orgs, logs a single structured line with the
 * counts (no PII — there is none, only counts), and always closes the client in a `finally`. Any failure is
 * logged as `auth.sweep.cron.error` (message only, never a secret/PII) and swallowed so the scheduled handler
 * never rejects. Returns the counts on success, or null on failure (for the caller / tests).
 */
export async function runAuthExpirySweep(
  env: Record<string, unknown>,
): Promise<{ refreshTokens: number; sessionExchanges: number } | null> {
  let validated: SweepEnv;
  try {
    validated = readSweepEnv(env);
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "auth.sweep.cron.error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }

  // Small pool: a single serial sweep. Caching stays irrelevant (a DELETE is never cached), but the binding
  // must still be the sweeper's own Hyperdrive (it carries the webhook_sweeper credential).
  const sql = createClient(validated.HYPERDRIVE_SWEEPER.connectionString, { max: 1 });
  try {
    const counts = await pruneAllExpiredAuthTokens(sql);
    console.log(JSON.stringify({ message: "auth.sweep.cron", ...counts }));
    return counts;
  } catch (error) {
    console.log(
      JSON.stringify({
        message: "auth.sweep.cron.error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  } finally {
    await sql
      .end()
      .catch((error: unknown) =>
        console.log(
          JSON.stringify({ message: "auth.sweep.cron.pool_close_failed", error: String(error) }),
        ),
      );
  }
}
