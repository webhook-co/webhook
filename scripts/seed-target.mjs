// Which database `pnpm seed` is allowed to write to — and the refusal that keeps it off every other one.
//
// The seeder is not a harmless script. It writes fixed-UUID orgs, users, memberships and endpoints; it signs
// their `org_created` audit rows with a dev audit key that is PUBLISHED IN THIS REPO; and it hashes their
// ingest tokens with a dev pepper that is published alongside it. Run against a real database, that is a
// data-integrity incident rather than a mess to clean up: those tenants' tamper-evident chains would be
// signed by a key anyone can read, which is precisely the property the chain exists to provide.
//
// And the way it would happen is ORDINARY, not exotic. `DATABASE_URL` is the same variable
// scripts/apply-prod-migrations.sh expects to hold the PROD owner connection. Anyone who has just run a
// migration has it exported. That script defends itself with MIGRATE_EXPECTED_DB_HOST for exactly this
// reason — "a mistyped/dev DATABASE_URL can't slip through" — and this one had no equivalent.
//
// So: fail closed on any host that is not this machine, reusing the SAME LOCAL_HOSTS set the rest of the dev
// tooling refuses on (scripts/dev-db-config.mjs), so there is one definition of "local" rather than two that
// can drift.
//
// THERE IS NO OVERRIDE FLAG, deliberately. An escape hatch here would be the thing someone sets when they
// are tired and certain, which is the exact state this guards against — and there is no legitimate reason to
// seed a remote database with fixed-UUID fixtures signed by a published key. If you genuinely need this data
// somewhere remote, write a migration.

import { LOCAL_HOSTS } from "./dev-db-config.mjs";

/**
 * Refusal to seed a database that is not on this machine. Carries the offending HOST as a field.
 *
 * The field is not decoration: a caller (or a test) that wants to know which host was refused should read
 * it, rather than pattern-matching the message. Substring-matching a hostname is both brittle and the exact
 * shape CodeQL flags as incomplete URL sanitization (js/regex/missing-regexp-anchor) — a rule that is right
 * in general even where, as here, the string being matched is an error message rather than a URL.
 */
export class NonLocalSeedTargetError extends Error {
  /** @param {string} host @param {string} message */
  constructor(host, message) {
    super(message);
    this.name = "NonLocalSeedTargetError";
    /** The hostname that was refused. */
    this.host = host;
  }
}

/** The superuser URL `pnpm dev:db` prints. */
export const DEFAULT_URL =
  "postgres://postgres:postgres@127.0.0.1:5432/webhook_dev?sslmode=disable";

/**
 * Pick the target. DEV_DB (what dev-db.sh prints) wins over DATABASE_URL (what the PROD migration runbook
 * uses) — belt and braces alongside the host check below.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveSeedUrl(env) {
  const devDb = env.DEV_DB?.trim();
  if (devDb) return devDb;
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) return databaseUrl;
  return DEFAULT_URL;
}

/**
 * Throw unless `url` points at this machine.
 *
 * The message names the HOST but never the URL — a connection string carries a password, and a refusal that
 * echoes it would put a live credential into a terminal and whatever scrollback captures it.
 *
 * @param {string} url
 */
export function assertLocalTarget(url) {
  /** @type {string} */
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new NonLocalSeedTargetError(
      "",
      "refusing to seed: the target is not a parseable connection URL. Expected something like " +
        "postgres://postgres@127.0.0.1:5432/webhook_dev",
    );
  }
  // WHATWG keeps the brackets on an IPv6 hostname; LOCAL_HOSTS holds the bare form.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!LOCAL_HOSTS.has(bare)) {
    throw new NonLocalSeedTargetError(
      bare,
      `refusing to seed: "${host}" is not this machine.\n\n` +
        `   The seeder writes fixed-UUID orgs and endpoints, signs their audit rows with a dev key that is\n` +
        `   PUBLISHED IN THIS REPO, and hashes their ingest tokens with a published dev pepper. Against a\n` +
        `   real database that is a data-integrity incident, not a mess to tidy up.\n\n` +
        `   DATABASE_URL is also what the prod-migration runbook uses, so this is usually a variable left\n` +
        `   exported from something else. Unset it, or set DEV_DB to your local database.`,
    );
  }
}
