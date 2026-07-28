// Preflight checks for the local dev cluster that scripts/dev-db.sh manages.
//
// scripts/dev-db.sh skips initdb whenever .dev-pg/ already exists, then starts that datadir with the
// pinned major's pg_ctl. So when the pin moved 14 → 17 (#734), every developer carrying an older
// cluster started getting a bare `FATAL: database files are incompatible with server` — accurate, and
// useless, because the fix (`nuke`, which DELETES the cluster) is not something you would guess.
//
// The version pair is pure data, so the decision lives here where it is tested, and the shell only
// reports it — the same split as dev-db-config.mjs.

import { readFileSync } from "node:fs";

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
  const expected = Number(expectedMajor);
  if (
    expectedMajor === undefined ||
    expectedMajor === null ||
    String(expectedMajor).trim() === "" ||
    !Number.isInteger(expected) ||
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
  if (!/^\d+$/.test(found)) {
    return {
      found,
      expected,
      message: unreadableMessage(found, expected),
    };
  }

  if (Number(found) === expected) return null;

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
 * Read `PG_VERSION` from a datadir. Returns null when the datadir (or the file) is absent, which is
 * the normal first-run state and not a fault.
 *
 * @param {string} pgdata
 * @returns {string|null}
 */
export function readDatadirVersion(pgdata) {
  try {
    return readFileSync(`${pgdata}/PG_VERSION`, "utf8");
  } catch {
    return null;
  }
}
