// Preflight checks for the local dev cluster that scripts/dev-db.sh manages.
//
// scripts/dev-db.sh skips initdb whenever .dev-pg/ already exists, then starts that datadir with the
// pinned major's pg_ctl. So when the pin moved 14 → 17 (#734), every developer carrying an older
// cluster started getting a bare `FATAL: database files are incompatible with server` — accurate, and
// useless, because the fix (`nuke`, which DELETES the cluster) is not something you would guess.
//
// The version pair is pure data, so the decision lives here where it is tested, and the shell only
// reports it — the same split as dev-db-config.mjs.

import { existsSync, readFileSync } from "node:fs";

/** The one command that resolves a datadir/binary version mismatch. Destructive by nature. */
export const RECOVERY_COMMAND = "scripts/dev-db.sh nuke && pnpm dev:db";

/**
 * Decide whether an existing datadir can be started by the pinned Postgres major.
 *
 * @param {object} input
 * @param {string|null|undefined} input.datadirVersion Contents of `.dev-pg/PG_VERSION`, or null/undefined
 *   when the datadir does not exist yet (initdb will create it — not a fault).
 * @param {number|string} input.expectedMajor The pinned `PG_MAJOR`. Accepts a numeric string because
 *   the caller is bash, which has no integer type.
 * @returns {{found: string, expected: number, message: string}|null} null when it is safe to start.
 */
export function datadirVersionFault({ datadirVersion, expectedMajor }) {
  // Test the STRING shape, not the coerced number: Number("0x11") is 17 and Number(" 17 ") is 17,
  // and neither is a plausible PG_MAJOR line in bash. A guard that accepts them does not mean what
  // its name says.
  const expected = Number(expectedMajor);
  if (
    expectedMajor === undefined ||
    expectedMajor === null ||
    !/^\d+$/.test(String(expectedMajor)) ||
    expected <= 0
  ) {
    // Fail loudly rather than silently disabling the check: an unset PG_MAJOR would otherwise make
    // every comparison vacuous, which is precisely the class of bug this module guards against.
    throw new Error(
      `dev-db preflight: expectedMajor must be a positive integer, got ${JSON.stringify(expectedMajor)}`,
    );
  }

  // No datadir yet — dev-db.sh will initdb it at the pinned major.
  if (datadirVersion === null || datadirVersion === undefined) return null;

  const found = String(datadirVersion).trim();

  // Anything we cannot parse means we cannot reason about the cluster. Starting it anyway reproduces
  // the opaque failure, so treat it as a fault and let the operator reset.
  // `9.6` is a real historical PG_VERSION (pre-10 used major.minor). The recovery is identical either
  // way, but the reason we print should be true — that is a mismatch, not an unreadable file.
  const major = /^(\d+)(?:\.\d+)?$/.exec(found);
  if (!major) {
    return {
      found,
      expected,
      message: unreadableMessage(found, expected),
    };
  }

  if (Number(major[1]) === expected) return null;

  return { found, expected, message: mismatchMessage(found, expected) };
}

function mismatchMessage(found, expected) {
  return [
    `.dev-pg is a PostgreSQL ${found} datadir, but this repo pins PostgreSQL ${expected}.`,
    `Postgres cannot start a ${found} cluster with ${expected} binaries, so the cluster must be recreated.`,
    ``,
    `  ${RECOVERY_COMMAND}`,
    ``,
    `This DELETES the local cluster. Nothing in the repo seeds it, so any local orgs, endpoints`,
    `or events you created will be lost and must be recreated.`,
  ].join("\n");
}

function unreadableMessage(found, expected) {
  return [
    `.dev-pg/PG_VERSION is unreadable (${JSON.stringify(found)}); expected a PostgreSQL ${expected} datadir.`,
    `The cluster cannot be verified, so it must be recreated.`,
    ``,
    `  ${RECOVERY_COMMAND}`,
    ``,
    `This DELETES the local cluster and any local data in it.`,
  ].join("\n");
}

/**
 * Read `PG_VERSION` from a datadir.
 *
 * @param {string} pgdata
 * @returns {string|null} null ONLY when the datadir itself is absent (the normal first-run state).
 *   A datadir that exists but cannot be read yields a sentinel string, which faults.
 */
export function readDatadirVersion(pgdata) {
  // null means exactly one thing to the caller: "no datadir — initdb will create it". A bare
  // `catch { return null }` also returned it for a datadir that EXISTS but whose PG_VERSION is absent
  // or unreadable (an interrupted `nuke`, a partial rm -rf, a copy that dropped hidden files, EACCES).
  // That is the dangerous direction: dev-db.sh keys initdb off `[ ! -d "$PGDATA" ]`, so the directory
  // being present means initdb is SKIPPED, and the script then dies on the opaque pg_ctl error this
  // module exists to prevent. Separate the two cases.
  if (!existsSync(pgdata)) return null;
  try {
    return readFileSync(`${pgdata}/PG_VERSION`, "utf8");
  } catch (err) {
    return `<unreadable: ${err.code ?? "unknown"}>`;
  }
}
