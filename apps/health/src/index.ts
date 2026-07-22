import { readSecretBinding } from "@webhook-co/shared";
import {
  publicReadyz,
  readinessProvider,
  runChecks,
  healthDocument,
} from "@webhook-co/shared/health";

import { beatKey, isRegisteredJob, jobChecks, REGISTERED_JOBS } from "./heartbeat";

/**
 * `health.wbhk.my` — the platform's derived-signal plane.
 *
 * Most status components are probed directly on their own hostname, so this Worker failing cannot
 * paint the whole page red. Only signals that have NO public endpoint of their own live here: the
 * scheduled jobs (which are observable solely by their absence) and, next, the delivery canary.
 *
 * It is deliberately vendor-neutral. Nothing here knows what a status page is — it exposes ordinary
 * HTTP endpoints that return 200 or 503, which any monitoring product can poll.
 */
export interface Env {
  readonly HEALTH_KV: KVNamespace;
  /** Bearer credential the crons authenticate with when reporting. */
  readonly HEARTBEAT_TOKEN: SecretsStoreSecret | string;
}

const SECURITY_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  "strict-transport-security": "max-age=63072000",
} as const;

const plain = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
    },
  });

/** This Worker's OWN readiness: it can serve a verdict only if its store is reachable. */
const ownReadiness = readinessProvider<Env>((env) => ({
  store: async () => {
    await env.HEALTH_KV.get(beatKey("__probe__"));
  },
}));

/**
 * Record a run. Authenticated, because an unauthenticated heartbeat endpoint lets anyone silence a
 * dead job by reporting on its behalf — which is strictly worse than having no heartbeat at all.
 *
 * Unknown job ids are rejected rather than stored: accepting them would let a typo'd id look like a
 * successful report while the real job stays silent, and would allow unbounded writes into KV.
 */
async function recordBeat(request: Request, env: Env, jobId: string): Promise<Response> {
  const expected = await readSecretBinding(env.HEARTBEAT_TOKEN).catch(() => "");
  const header = request.headers.get("authorization") ?? "";
  // 404 rather than 401 throughout, so probing cannot map which ids or credentials exist.
  if (!expected || header !== `Bearer ${expected}`) return plain("Not found", 404);
  if (!isRegisteredJob(jobId)) return plain("Not found", 404);

  const ok = new URL(request.url).searchParams.get("status") !== "fail";
  await env.HEALTH_KV.put(beatKey(jobId), JSON.stringify({ ts: Date.now(), ok }));
  return plain("recorded", 202);
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/healthz") return plain("ok", 200);

  if (request.method === "GET" && url.pathname === "/readyz") {
    return publicReadyz(await ownReadiness(env), SECURITY_HEADERS);
  }

  // The scheduled-jobs component. Evaluated per request rather than through the shared readiness
  // cache: it is polled infrequently, reads only KV, and a cached verdict would delay the very
  // signal it exists to surface.
  if (request.method === "GET" && url.pathname === "/component/jobs") {
    const outcomes = await runChecks(jobChecks(env.HEALTH_KV), { timeoutMs: 3_000 });
    return publicReadyz(
      healthDocument(outcomes, { time: new Date().toISOString() }),
      SECURITY_HEADERS,
    );
  }

  const beat = /^\/internal\/heartbeat\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
  if (request.method === "POST" && beat) return recordBeat(request, env, beat[1] as string);

  return plain("Not found", 404);
}

export default {
  fetch: handleFetch,
} satisfies ExportedHandler<Env>;

export { REGISTERED_JOBS };
