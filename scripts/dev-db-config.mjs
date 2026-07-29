// The dev-DB shape, DERIVED from the wrangler configs rather than restated here.
//
// `wrangler dev` connects each Hyperdrive binding to its `localConnectionString`, and those strings
// name the role they connect as (webhook_billing, webhook_app, …). A hand-maintained role list in the
// bootstrap would drift the moment a binding is added, and the failure is a confusing runtime auth
// error inside a Worker, not a clear one. So: read the bindings, take the roles they actually ask for.
//
// Non-localhost strings are ignored (a real Neon/Hyperdrive URL is not a dev target), and any
// disagreement between local bindings about host/port/database/password is fatal — a half-provisioned
// cluster is worse than none.

/** The only hosts any dev tooling may touch. Exported so there is ONE definition of "local" —
 *  scripts/seed.ts fails closed against this same set. */
export const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// The database name and every role name reach a shell assignment AND raw SQL in scripts/dev-db.sh
// (`rolname='$role'`, `createdb "$DB"`, the dbmate DATABASE_URL). They come from url.pathname and
// url.username of a connection string in a wrangler.jsonc, and WHATWG percent-encoding leaves `;`,
// `$`, backtick, `|`, `'` and `"` intact — so an unvalidated value is a live injection primitive in
// both languages. Constrain them to plain Postgres identifiers here, at the single point every
// consumer goes through, rather than escaping correctly at each of the call sites.
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @param {string} value @param {string} label */
function assertIdentifier(value, label) {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(
      `wrangler local bindings name a ${label} that is not a plain Postgres identifier: ` +
        `${JSON.stringify(value)}. Expected /${IDENTIFIER_RE.source}/ — these values are interpolated ` +
        `into shell commands and SQL by scripts/dev-db.sh.`,
    );
  }
}

/** Matches the `localConnectionString` values in apps/<x>/wrangler.jsonc, whatever the surrounding JSONC. */
const CONN_RE = /"localConnectionString"\s*:\s*"([^"]+)"/g;

/**
 * @param {readonly string[]} configTexts Raw text of each wrangler.jsonc (JSONC — not JSON-parseable).
 * @returns {{host: string, port: number, database: string, superuser: string, password: string, roles: string[]}}
 */
export function parseDevDbConfig(configTexts) {
  /** @type {{user: string, password: string, host: string, port: number, database: string}[]} */
  const local = [];

  for (const text of configTexts) {
    for (const [, raw] of text.matchAll(CONN_RE)) {
      const url = new URL(raw);
      const host = url.hostname;
      if (!LOCAL_HOSTS.has(host)) continue; // a hosted DB — not ours to provision
      local.push({
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        host,
        port: Number(url.port || 5432),
        database: url.pathname.replace(/^\//, ""),
      });
    }
  }

  if (local.length === 0) {
    throw new Error(
      "no local `localConnectionString` found in the wrangler configs — nothing to provision",
    );
  }

  const [first] = local;
  for (const c of local) {
    for (const field of /** @type {const} */ (["host", "port", "database", "password"])) {
      if (c[field] !== first[field]) {
        throw new Error(
          `wrangler local bindings disagree on ${field}: ` +
            `"${String(first[field])}" vs "${String(c[field])}". ` +
            `Every localConnectionString must point at the same dev cluster.`,
        );
      }
    }
  }

  // The superuser is whoever the plain (unqualified) bindings connect as — it owns the cluster and is
  // created by initdb, so it is never in the "roles to create" list. The migrations create the rest.
  const superuser = "postgres";
  const roles = [...new Set(local.map((c) => c.user))].filter((u) => u !== superuser).sort();

  // Validate after the agreement check, so a genuine misconfiguration still reports the clearer
  // "bindings disagree" message rather than an identifier complaint about one arbitrary binding.
  assertIdentifier(first.database, "database");
  assertIdentifier(superuser, "superuser");
  for (const role of roles) assertIdentifier(role, "role");

  return {
    host: first.host,
    port: first.port,
    database: first.database,
    superuser,
    password: first.password,
    roles,
  };
}
