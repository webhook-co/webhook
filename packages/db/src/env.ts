// Connection-string resolution for Node contexts (migrations, tests, local dev
// scripts). In Workers the connection string comes from the Hyperdrive binding
// (env.HYPERDRIVE_TENANT.connectionString) and is passed to createClient directly;
// this helper is for the Node side only.
//
// The local vs dev vs prod distinction is a binding/connection-string swap, not a
// code fork: the same data-access code runs everywhere. Prod and dev never share a
// connection string (separate Neon projects).

const VAR = "DATABASE_URL";

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env[VAR];
  if (!url || url.trim() === "") {
    throw new Error(
      `${VAR} is not set. Local dev/tests get it from the ephemeral-Postgres harness; ` +
        `dev/prod come from per-environment Hyperdrive bindings (separate Neon projects).`,
    );
  }
  return url;
}
