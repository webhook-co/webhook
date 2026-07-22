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
export const dynamic = "force-dynamic";

/**
 * Exported with an injectable ping so both the configured and the MISSING-binding paths are
 * asserted. A missing binding throws, which `runChecks` turns into `fail` -> 503; returning a
 * placeholder DSN would let a misconfigured deploy report healthy.
 */
export function webReadinessChecks(
  env: { HYPERDRIVE_TENANT?: { connectionString?: string } },
  ping: (dsn: string) => Promise<void> = pingDatabase,
) {
  return {
    database: () => {
      const dsn = env.HYPERDRIVE_TENANT?.connectionString;
      if (!dsn) throw new Error("HYPERDRIVE_TENANT binding is not configured");
      return ping(dsn);
    },
  };
}

const readiness = readinessProvider<{ HYPERDRIVE_TENANT?: { connectionString?: string } }>((env) =>
  webReadinessChecks(env),
);

export async function GET(): Promise<Response> {
  // The ASYNC form, and NO `runtime = "edge"`. OpenNext runs Next in the Node runtime on workerd:
  // declaring the edge runtime builds this as an Edge Function where the context is not available
  // the same way, and the sync accessor is not valid there either. Both mistakes produced a 500 in
  // production rather than a readiness verdict — the app's own DAL uses this exact form.
  const { env } = await getCloudflareContext({ async: true });
  return publicReadyz(
    await readiness(env as unknown as { HYPERDRIVE_TENANT?: { connectionString?: string } }),
  );
}
