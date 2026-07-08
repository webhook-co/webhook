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
