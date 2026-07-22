import { createClient } from "./client";

/**
 * Prove that a Hyperdrive-backed role can reach Postgres, for a `/readyz` readiness probe.
 *
 * `select 1` needs no table privileges, so this works for every least-privilege role in the estate
 * (webhook_ingest, webhook_app, webhook_auth, ...) without granting any of them extra access, and it
 * reads no tenant data.
 *
 * Probe the binding whose role actually serves the traffic the endpoint is reporting on. Pinging a
 * different role's binding reports a healthy database while the role that does the work is
 * unreachable — a green probe over a broken service is worse than no probe.
 *
 * The client is closed in a `finally`. A readiness endpoint that leaked a pooled connection per
 * probe would, given enough probes, become the outage it exists to detect.
 */
export async function pingDatabase(connectionString: string): Promise<void> {
  const sql = createClient(connectionString, { max: 1 });
  try {
    await sql`select 1`;
  } finally {
    await sql.end().catch(() => undefined);
  }
}
