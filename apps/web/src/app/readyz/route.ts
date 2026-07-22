import { pingDatabase } from "@webhook-co/db/health";
import { publicReadyz, readinessProvider } from "@webhook-co/shared/health";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Dashboard readiness (`app.webhook.co/readyz`).
 *
 * Every authenticated dashboard page reads tenant rows under RLS through HYPERDRIVE_TENANT, so that
 * binding is what "can the dashboard serve" reduces to. This deliberately renders NO React and
 * touches no session: a readiness probe that depended on the page tree would report the framework's
 * health rather than the service's.
 */
// dal-gate-allow: readiness runs `select 1` and reads no row, no session and no tenant data. Gating
// it on verifySession() would make the probe report whether a CALLER is authenticated rather than
// whether the service can serve, and would make it unusable by an external prober.
export const runtime = "edge";
export const dynamic = "force-dynamic";

const readiness = readinessProvider<{ HYPERDRIVE_TENANT?: { connectionString?: string } }>(
  (env) => ({
    database: () => {
      const dsn = env.HYPERDRIVE_TENANT?.connectionString;
      if (!dsn) throw new Error("HYPERDRIVE_TENANT binding is not configured");
      return pingDatabase(dsn);
    },
  }),
);

export async function GET(): Promise<Response> {
  const { env } = getCloudflareContext();
  return publicReadyz(
    await readiness(env as unknown as { HYPERDRIVE_TENANT?: { connectionString?: string } }),
  );
}
