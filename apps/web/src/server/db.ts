import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { createClient, type Sql } from "@webhook-co/db/client";

/**
 * A per-request tenant Postgres client over the `webhook_app` Hyperdrive pool — the same RLS-scoped
 * pool apps/api uses (`createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 1 })`). The dashboard's
 * credential server actions run Lane B's db functions through this under `withTenant(orgId)`, so RLS (via
 * the session `orgId`) is the tenant-isolation backstop. Read per-request — bindings aren't available at
 * module load on workerd; a fresh small pool per request matches the Workers model.
 */
interface HyperdriveBinding {
  readonly connectionString: string;
}

export async function getTenantDb(): Promise<Sql> {
  const { env } = await getCloudflareContext({ async: true });
  const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE_TENANT as
    | HyperdriveBinding
    | undefined;
  if (!hyperdrive?.connectionString) {
    throw new Error("HYPERDRIVE_TENANT binding is not configured");
  }
  return createClient(hyperdrive.connectionString, { max: 1 });
}
