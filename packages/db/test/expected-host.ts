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
    host = normaliseHost(new URL(url).hostname);
  } catch {
    // We cannot tell whether an unparseable URL is local or managed, so we cannot clear it. Fail
    // closed. (startEphemeralPostgres would throw on this URL a moment later anyway — but it would
    // do so AFTER the globalSetup sweep had already run.)
    throw new UnexpectedTestClusterError(
      `TEST_DATABASE_URL is not a parseable URL, so the target cluster cannot be verified. ` +
        `Refusing to run — the harness rotates cluster-global role passwords and drops databases.`,
    );
  }

  // The host parsed above must be the host the CLIENT will actually dial, or we would be asserting
  // about one cluster and mutating another. Two known divergences, both rejected outright rather
  // than guessed at:
  //
  //   - postgres.js splits userinfo at the FIRST '@', WHATWG at the LAST. A password containing an
  //     unencoded '@' therefore yields two different hosts from the same string. Percent-encode it.
  //   - libpq accepts a COMMA-SEPARATED host list; WHATWG parses the whole thing as one hostname.
  //
  // Neither is legitimate in any of our lanes, so refusing costs nothing and closes the bypass.
  const authority = url.slice(url.indexOf("//") + 2).split(/[/?#]/)[0]!;
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  if ((authority.match(/@/g) ?? []).length > 1) {
    throw new UnexpectedTestClusterError(
      `TEST_DATABASE_URL contains more than one '@' before the path, so the host this assertion ` +
        `parses ('${host}') is not necessarily the host the driver will dial. Percent-encode '@' ` +
        `in the password. Refusing to run.`,
    );
  }
  if (hostPart.includes(",")) {
    throw new UnexpectedTestClusterError(
      `TEST_DATABASE_URL names multiple hosts ('${hostPart}'), so which cluster is mutated is not ` +
        `determined by this assertion. Refusing to run — use a single host.`,
    );
  }

  // LOOPBACK is the only host that cannot be shared by construction: the local ephemeral cluster
  // lives on 127.0.0.1, and the PR-CI service container on `localhost` (ci.yml). Everything else —
  // including a trust-auth Postgres on a LAN address, a colleague's dev box, or a managed cluster
  // reached with `sslmode=verify-full` — must be named.
  //
  // The auth mode CANNOT stand in for this, and the first cut of this file used it: it exempted
  // anything that merely looked trust-auth, so `TEST_DATABASE_URL=postgres://postgres@<lan-host>/…`
  // with TEST_DATABASE_EXPECTED_HOST naming a completely different cluster ran happily and created
  // (then dropped) 19 cluster-global roles on the unnamed host. Found by adversarial review and
  // reproduced end to end; the regression is pinned in expected-host.test.ts.
  if (isLoopback(host)) return;

  const damage =
    `The harness provisions and mutates CLUSTER-GLOBAL roles, DROPs every webhook_test_* database ` +
    `it can see, and (in migrations.test.ts) rolls migrations down far enough to DROP those roles. ` +
    `Every environment shares these role names, so nothing downstream would fail early.`;

  if (expected === undefined || expected.trim() === "") {
    throw new UnexpectedTestClusterError(
      `refusing to run against the Postgres at '${host}': ${EXPECTED_HOST_ENV} is not set, so the ` +
        `target cluster is unproven. ${damage} Set ${EXPECTED_HOST_ENV} to the host you intend to ` +
        `mutate.`,
    );
  }

  if (normaliseHost(expected) !== host) {
    throw new UnexpectedTestClusterError(
      `refusing to run: TEST_DATABASE_URL points at '${host}', but ${EXPECTED_HOST_ENV} names ` +
        `'${expected.trim()}'. ${damage}`,
    );
  }
}

/** Hostnames are case-insensitive and a single trailing dot is the same host — normalise both sides
 *  so an equivalent spelling neither false-refuses nor slips past the equality check. */
function normaliseHost(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** True for the loopback interface in every spelling `new URL()` can produce. NOT a general
 *  "is this private" test — a LAN address is deliberately NOT exempt. */
function isLoopback(host: string): boolean {
  if (host === "localhost" || host === "[::1]" || host === "::1") return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
