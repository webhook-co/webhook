import { readSecretBinding } from "@webhook-co/shared";
import {
  publicReadyz,
  readinessProvider,
  runChecks,
  healthDocument,
} from "@webhook-co/shared/health";

import { deliveryChecks } from "./canary";
import { readState, recordReceipt, runCanaryTick } from "./canary-runner";
import { beatKey, isRegisteredJob, jobChecks, REGISTERED_JOBS } from "./heartbeat";

/**
 * `health.wbhk.my` — the platform's derived-signal plane.
 *
 * Most status components are probed directly on their own hostname, so this Worker failing cannot
 * paint the whole page red. Only signals that have NO public endpoint of their own live here: the
 * scheduled jobs (observable solely by their absence) and the end-to-end delivery canary.
 *
 * It is deliberately vendor-neutral. Nothing here knows what a status page is — it exposes ordinary
 * HTTP endpoints that return 200 or 503, which any monitoring product can poll.
 */
export interface Env {
  readonly HEALTH_KV: KVNamespace;
  /** Bearer credential the crons authenticate with when reporting. */
  readonly HEARTBEAT_TOKEN: SecretsStoreSecret | string;
  /**
   * The live ingest URL the canary posts to. A SECRET: its path carries an ingest token, which is
   * why this Worker is classified tracing-forbidden — an auto fetch span would capture it.
   */
  readonly CANARY_INGEST_URL?: SecretsStoreSecret | string;
  /** Shared secret proving a delivery landing on /sink really came from our own pipeline. */
  readonly CANARY_SINK_SECRET?: SecretsStoreSecret | string;
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

  // The delivery component. Backed by the canary's freshness rather than by any live probe: the
  // pipeline is asynchronous, so there is nothing to ask whether it is up.
  if (request.method === "GET" && url.pathname === "/component/delivery") {
    const outcomes = await runChecks(
      deliveryChecks(() => readState(env.HEALTH_KV)),
      {
        timeoutMs: 3_000,
      },
    );
    return publicReadyz(
      healthDocument(outcomes, { time: new Date().toISOString() }),
      SECURITY_HEADERS,
    );
  }

  if (request.method === "POST" && url.pathname === "/sink") return handleSink(request, env);

  const beat = /^\/internal\/heartbeat\/([A-Za-z0-9-]{1,64})$/.exec(url.pathname);
  if (request.method === "POST" && beat) return recordBeat(request, env, beat[1] as string);

  return plain("Not found", 404);
}

/**
 * Receive a delivered canary event.
 *
 * Authenticated with a shared secret rather than left open: an unauthenticated sink lets anyone
 * forge a receipt, which would report a healthy delivery pipeline while it is actually broken —
 * the single worst failure this component can have.
 */
export async function handleSink(request: Request, env: Env): Promise<Response> {
  const expected = env.CANARY_SINK_SECRET
    ? await readSecretBinding(env.CANARY_SINK_SECRET).catch(() => "")
    : "";
  if (!expected || request.headers.get("x-canary-secret") !== expected) {
    return plain("Not found", 404);
  }

  const body = (await request.json().catch(() => null)) as { nonce?: unknown } | null;
  const nonce = typeof body?.nonce === "string" ? body.nonce : "";
  if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return plain("Not found", 404);

  await recordReceipt(env.HEALTH_KV, nonce, Date.now());
  return plain("received", 202);
}

/** POST the synthetic event. Non-2xx throws so the tick records no receipt for it. */
async function sendCanaryEvent(env: Env, nonce: string): Promise<void> {
  const target = env.CANARY_INGEST_URL
    ? await readSecretBinding(env.CANARY_INGEST_URL).catch(() => "")
    : "";
  if (!target) throw new Error("CANARY_INGEST_URL is not configured");
  const res = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, source: "canary" }),
  });
  if (!res.ok) throw new Error(`ingest responded ${res.status}`);
}

export default {
  fetch: handleFetch,

  /**
   * The canary tick, fired every five minutes. Correlates the previous nonce, then arms a new
   * one; see
   * runCanaryTick for why a failed send still advances the state.
   */
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(
      runCanaryTick({
        store: env.HEALTH_KV,
        send: (nonce) => sendCanaryEvent(env, nonce),
        nonce: () => crypto.randomUUID(),
        now: () => Date.now(),
      }).then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;

export { REGISTERED_JOBS };
