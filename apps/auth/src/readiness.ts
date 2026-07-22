import { pingDatabase } from "@webhook-co/db/health";

/**
 * auth readiness, kept in its own module rather than inside `worker.ts`.
 *
 * `worker.ts` imports the OpenNext build output, which does not exist at test time — so readiness
 * living there would be untestable, and an untestable probe is how an unexercised one ships.
 *
 * webhook_auth backs the issuer's own global reads; webhook_app backs the org-scoped reads the login
 * flow performs under RLS. They are checked SEPARATELY because a rotated password breaks one role
 * while the cluster stays up, and a single ping reports healthy straight through that.
 */
export function authReadinessChecks(
  env: Record<string, unknown>,
  ping: (dsn: string) => Promise<void> = pingDatabase,
) {
  return {
    database: () => ping(hyperdriveDsn(env, "HYPERDRIVE_AUTH")),
    tenant: () => ping(hyperdriveDsn(env, "HYPERDRIVE_TENANT")),
  };
}

/**
 * Read a Hyperdrive binding's DSN, THROWING when it is absent so the check reports `fail`.
 * Returning a placeholder would let a misconfigured deploy report healthy.
 */
export function hyperdriveDsn(env: Record<string, unknown>, binding: string): string {
  const hd = env[binding] as { connectionString?: string } | undefined;
  if (!hd?.connectionString) throw new Error(`${binding} binding is not configured`);
  return hd.connectionString;
}
