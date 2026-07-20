// Timing/resilience helpers for the DB integration suites when they run against a
// REAL managed engine (the nightly Neon branch) rather than a local ephemeral cluster.
//
// Neon's per-operation latency is both higher and far more variable than the local
// Postgres these tests are tuned against (cold-start + autoscale). Operations that are
// comfortable locally sit near the 30s timeout ceilings on Neon, so on a slow night a
// timeout-bound step (a connect, or a round-trip-heavy test) tips over. These helpers
// let the suites (a) recognise a remote target and (b) widen their budgets + pre-warm
// the compute so normal latency variance stops false-failing an otherwise-green run.

/**
 * True when the DB under test is a remote/managed engine (Neon), not a local ephemeral
 * cluster (no TEST_DATABASE_URL) or a trust-auth CI service container (no password/TLS).
 * Mirrors the harness's password-mode detection in test/pg.ts: a managed engine requires
 * TLS and authenticates with a password; a local trust service does neither.
 */
export function isRemoteTestDatabase(url = process.env.TEST_DATABASE_URL): boolean {
  if (!url || url.trim() === "") return false;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("sslmode") === "require" || parsed.password !== "";
  } catch {
    return false;
  }
}

export interface TestTimeouts {
  testTimeout: number;
  hookTimeout: number;
}

// Tight budgets for the local/CI-service path (fast, fail early). The generous remote
// budgets give Neon's variable latency headroom — the RLS suite's multi-pool setup and the
// round-trip-heavy read suites sit near the local ceilings on a slow/contended Neon night.
// These are ceilings, not expected durations.
const LOCAL_TIMEOUTS: TestTimeouts = { testTimeout: 30_000, hookTimeout: 60_000 };
const REMOTE_TIMEOUTS: TestTimeouts = { testTimeout: 120_000, hookTimeout: 180_000 };

/** Pick vitest test/hook timeouts based on whether the target is a remote engine. */
export function remoteTestTimeouts(url = process.env.TEST_DATABASE_URL): TestTimeouts {
  return isRemoteTestDatabase(url) ? REMOTE_TIMEOUTS : LOCAL_TIMEOUTS;
}

// Per-hook budgets for the provisioning `beforeAll` blocks (create per-file DB + apply all
// migrations + seed). Those blocks pass an explicit timeout literal to vitest, which OVERRIDES
// the config-level hookTimeout above — so the remote widening there never reaches them unless
// they opt in via setupHookTimeoutMs(). Local stays at the historical 90s (a heavy seed on the
// ephemeral cluster still wants headroom); remote gets 180s for Neon's slow/contended nights.
const LOCAL_SETUP_HOOK_TIMEOUT_MS = 90_000;
const REMOTE_SETUP_HOOK_TIMEOUT_MS = 180_000;

/**
 * Timeout (ms) for a suite's provisioning `beforeAll`, passed at the call site as
 * `beforeAll(fn, setupHookTimeoutMs())`. Remote (Neon) gets a wider budget than the local/CI
 * path — mirroring remoteTestTimeouts — because a per-hook literal overrides the config
 * hookTimeout, so without this a slow Neon night tips an otherwise-green setup over the local
 * ceiling (this is exactly what failed index-usage.test.ts on run 28932922311).
 */
export function setupHookTimeoutMs(url = process.env.TEST_DATABASE_URL): number {
  return isRemoteTestDatabase(url) ? REMOTE_SETUP_HOOK_TIMEOUT_MS : LOCAL_SETUP_HOOK_TIMEOUT_MS;
}

// A round-trip-heavy test (the GIN write-amp benchmark issues ~630 sequential EXPLAIN ANALYZE
// inserts) is bounded by RTT × round-trips, not by the per-test testTimeout tuned for a typical
// handful-of-queries test. Its ASSERTION is already RTT-immune — it reads Postgres's own "Execution
// Time", never the wall clock — but its DURATION is not. On a slow/contended Neon night the WHOLE db
// suite ran ~4.4x slower (run 29734739727: 1577s → 6971s across 1495 tests), which dragged this one
// test from a comfortable 47s over the 120s ceiling and false-RED'd an otherwise-green run, twice.
// This gives such a test a budget sized to its round-trip count on remote — a wide ceiling, not an
// expected duration — while local keeps the tight budget (630 round-trips over a unix socket is a
// few seconds). Same shape as setupHookTimeoutMs: a per-call literal overrides the config testTimeout.
const REMOTE_ROUND_TRIP_HEAVY_TEST_TIMEOUT_MS = 300_000;

/**
 * Timeout (ms) for a single round-trip-heavy test, passed at the call site as
 * `it(name, fn, roundTripHeavyTestTimeoutMs())`. Remote (Neon) gets a wide budget so RTT variance on
 * a slow night cannot false-fail a test whose assertion never depended on the wall clock; local stays
 * at the tight per-test budget. Reach for this ONLY for tests that legitimately do far more
 * round-trips than a typical one — it is a latency ceiling, not a licence to write slow tests.
 */
export function roundTripHeavyTestTimeoutMs(url = process.env.TEST_DATABASE_URL): number {
  return isRemoteTestDatabase(url)
    ? REMOTE_ROUND_TRIP_HEAVY_TEST_TIMEOUT_MS
    : LOCAL_TIMEOUTS.testTimeout;
}

// Per-migration budget + a fixed base, for a test that peels/re-applies the migration stack with
// dbmate (migrateDown / migrateDownAll). Each step spawns a FRESH dbmate connection, so cost is
// O(migrations) in connection setups — on the nightly Neon path (TLS + SCRAM per connect over the
// network) that scales past the default 30s as migrations accumulate. Sizing to the work makes the
// budget auto-scale with the migration count instead of needing a bump every few migrations (local
// ephemeral PG runs the whole loop in ~1s; this only bites on Neon). Unlike roundTripHeavyTestTimeoutMs
// (a FLAT remote ceiling for a FIXED round-trip count, e.g. the GIN benchmark's 630 inserts), this
// budget GROWS with the schema — the right model when the round-trip count itself grows over time.
const MIGRATION_STEP_BUDGET_MS = 6_000;
const MIGRATION_ROUNDTRIP_BASE_MS = 30_000;

/**
 * Per-test timeout (ms) for a migration reversibility/roundtrip test, passed at the call site as
 * `it(name, fn, migrationRoundtripTimeoutMs(migrationCount()))`. Scales with the number of migrations
 * because each dbmate down/up step is O(1) connection setups and the loop peels O(migrations) of them;
 * a fixed literal silently drifts toward the ceiling as migrations land (migration-0055-roundtrip sat
 * at ~109s of the 120s default on the 2026-07-20 Neon night — one slow night, or a few new migrations,
 * from a false RED). Deliberately un-guarded on remote/local: the generous budget is a harmless ceiling
 * on the fast local path and only bites on Neon.
 */
export function migrationRoundtripTimeoutMs(migrationCount: number): number {
  return migrationCount * MIGRATION_STEP_BUDGET_MS + MIGRATION_ROUNDTRIP_BASE_MS;
}

// The harness names each per-run test database `webhook_test_<hex>` (test/pg.ts). The
// trailing underscore is required so the bare local default `webhook_test`, and real app
// databases (`webhook`, `webhook_prod`, `neondb`, …), can never match.
const TEST_DATABASE_PREFIX = "webhook_test_";

/**
 * From a list of database names, pick the per-run test databases safe to drop — i.e. those
 * matching the harness prefix, excluding the connection's own (maintenance) database.
 *
 * Roles are cluster-global on the shared nightly Neon compute, so a database orphaned by a
 * crashed/cancelled/timed-out prior run still pins those roles via its grants/policies and
 * can block a later run's migration-down `DROP ROLE`. Sweeping these at startup prevents
 * that. Pure + exhaustively tested; the destructive drop lives in the globalSetup shell.
 */
export function orphanTestDatabases(datnames: string[], currentDatabase: string): string[] {
  return datnames.filter(
    (name) => name.startsWith(TEST_DATABASE_PREFIX) && name !== currentDatabase,
  );
}

export interface WaitForDatabaseOptions {
  /** One readiness probe; must throw/reject when the DB is not yet accepting queries. */
  probe: () => Promise<void>;
  /** Total probe attempts (default 20). */
  attempts?: number;
  /** Delay between attempts, ms (default 3000). */
  delayMs?: number;
  /** Called before each inter-attempt sleep (e.g. to log the wake progress). */
  onRetry?: (info: { attempt: number; attempts: number; error: unknown }) => void;
  /** Injectable sleep (defaults to setTimeout) so tests need no real time. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `probe` until it succeeds or `attempts` is exhausted, sleeping `delayMs` between
 * tries. Used to wake a suspended Neon compute BEFORE the timed suites run, so cold-start
 * latency lands here (untimed) instead of inside a test's or hook's timeout budget.
 * Sleeps only between attempts — never after the final one. Throws the last error wrapped
 * with the attempt count if the DB never becomes ready.
 */
export async function waitForDatabase(opts: WaitForDatabaseOptions): Promise<void> {
  const { probe, attempts = 20, delayMs = 3_000, onRetry, sleep = defaultSleep } = opts;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        onRetry?.({ attempt, attempts, error });
        await sleep(delayMs);
      }
    }
  }
  throw new Error(
    `database did not become ready after ${attempts} attempt(s): ${String(lastError)}`,
  );
}
