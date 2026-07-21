// Fail closed when TEST_DATABASE_URL names a cluster we were not told to expect (#727).
//
// WHY THIS EXISTS. Rules R1–R5 in scripts/remote-db-test-guard.mjs constrain WHICH ROLE may run a
// statement. None of them constrains WHICH CLUSTER the statement lands on. On the password path the
// harness then, unconditionally:
//
//   - rotates the password of every role in DB_ROLES (test/migrate.ts bootstrapOwner +
//     applyRolePasswords) — and Postgres roles are CLUSTER-GLOBAL, not per-database;
//   - `DROP DATABASE … WITH (FORCE)`s every `webhook_test_*` it can see (test/global-setup.ts);
//   - in migrations.test.ts runs migrateDownAll, whose down-sections DROP those cluster-global roles.
//
// Every environment uses the SAME role names and every role create is `if not exists`-guarded, so
// none of the above fails early on the wrong target: a mistyped or mis-pasted URL simply proceeds and
// lands its damage. You need a valid connection string to trigger it, so this is an operational
// footgun rather than an externally-reachable hole — but the blast radius is a full outage, and until
// now there was nothing between the two.
//
// The check lives HERE, called from startEphemeralPostgres() and the vitest globalSetup, rather than
// in a wrapper script: a wrapper is bypassed by a direct `TEST_DATABASE_URL=… vitest` invocation.
// scripts/remote-db-test-guard.mjs (R6) pins both call sites AND their ordering, so the assertion
// cannot be quietly moved after the first destructive statement.
//
// There is a ratified in-repo precedent for this hazard class one layer up:
// scripts/apply-prod-migrations.sh refuses to run unless the resolved host equals
// MIGRATE_EXPECTED_DB_HOST. This is the same assertion, applied to the test harness.

import { isRemoteTestDatabase } from "./pg-timing";

/** The environment variable that must name the cluster a shared/managed run is allowed to touch. */
export const EXPECTED_HOST_ENV = "TEST_DATABASE_EXPECTED_HOST";

/** Thrown instead of proceeding when the target cluster is unproven. Never carries the URL. */
export class UnexpectedTestClusterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnexpectedTestClusterError";
  }
}

/**
 * Refuse to run against a shared/managed Postgres unless it is the one we were told to expect.
 *
 * No-op on the fast lanes: no TEST_DATABASE_URL (the local ephemeral cluster) and the trust-auth CI
 * service (no password, no TLS) have nothing shared to protect, so local + PR CI cost nothing.
 *
 * On the shared path the expectation is REQUIRED — an unset TEST_DATABASE_EXPECTED_HOST refuses
 * rather than defaulting to "allow", because the whole point is that a mis-pointed run must not be
 * able to proceed by omission. Matching is an EXACT hostname equality: a prefix/suffix test would
 * admit a pooler endpoint (`…-pooler.…`) or a lookalike suffix.
 *
 * The failure NEVER echoes the connection string — only the parsed host, which is not a secret.
 *
 * @param url      the connection string under test (defaults to TEST_DATABASE_URL)
 * @param expected the cluster we are allowed to touch (defaults to TEST_DATABASE_EXPECTED_HOST)
 */
export function assertExpectedTestDatabaseHost(
  url: string | undefined = process.env.TEST_DATABASE_URL,
  expected: string | undefined = process.env.TEST_DATABASE_EXPECTED_HOST,
): void {
  // No TEST_DATABASE_URL at all: startEphemeralPostgres spawns a throwaway local cluster. Nothing
  // shared exists to mis-target.
  if (url === undefined || url.trim() === "") return;

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // We cannot tell whether an unparseable URL is local or managed, so we cannot clear it. Fail
    // closed. (startEphemeralPostgres would throw on this URL a moment later anyway — but it would
    // do so AFTER the globalSetup sweep had already run.)
    throw new UnexpectedTestClusterError(
      `TEST_DATABASE_URL is not a parseable URL, so the target cluster cannot be verified. ` +
        `Refusing to run — the harness rotates cluster-global role passwords and drops databases.`,
    );
  }

  // Trust-auth (no password, no TLS) ⇒ the local ephemeral cluster or the PR-CI service container.
  // Deliberately the SAME predicate the timing helpers use, so the two can never drift into
  // disagreeing about what "remote" means.
  if (!isRemoteTestDatabase(url)) return;

  const damage =
    `The harness rotates CLUSTER-GLOBAL role passwords, DROPs every webhook_test_* database it ` +
    `can see, and (in migrations.test.ts) rolls migrations down far enough to DROP those roles. ` +
    `Every environment shares these role names, so nothing downstream would fail early.`;

  if (expected === undefined || expected.trim() === "") {
    throw new UnexpectedTestClusterError(
      `refusing to run against the managed Postgres at '${host}': ${EXPECTED_HOST_ENV} is not set, ` +
        `so the target cluster is unproven. ${damage} Set ${EXPECTED_HOST_ENV} to the host you ` +
        `intend to mutate.`,
    );
  }

  if (expected.trim() !== host) {
    throw new UnexpectedTestClusterError(
      `refusing to run: TEST_DATABASE_URL points at '${host}', but ${EXPECTED_HOST_ENV} names ` +
        `'${expected.trim()}'. ${damage}`,
    );
  }
}
