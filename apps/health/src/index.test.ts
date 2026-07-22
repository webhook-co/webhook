import { describe, expect, it } from "vitest";

import { handleFetch, type Env } from "./index";
import { beatKey, REGISTERED_JOBS } from "./heartbeat";

/** An in-memory stand-in for the KV namespace, exposing only what the Worker uses. */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    kv: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => void store.set(key, value),
    } as unknown as KVNamespace,
    store,
  };
}

const envWith = (seed: Record<string, string> = {}, token = "s3cret") => {
  const { kv, store } = fakeKv(seed);
  return { env: { HEALTH_KV: kv, HEARTBEAT_TOKEN: token } as Env, store };
};

const req = (path: string, init?: RequestInit) =>
  new Request(`https://health.wbhk.my${path}`, init);

const freshBeats = (now = Date.now()) =>
  Object.fromEntries(
    REGISTERED_JOBS.map((j) => [beatKey(j.id), JSON.stringify({ ts: now, ok: true })]),
  );

describe("liveness and readiness", () => {
  it("answers /healthz without touching the store", async () => {
    const env = { HEARTBEAT_TOKEN: "x" } as unknown as Env; // no KV bound at all
    const res = await handleFetch(req("/healthz"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("keeps every response out of caches and search indexes", async () => {
    const { env } = envWith();
    const res = await handleFetch(req("/healthz"), env);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /internal/heartbeat/:job", () => {
  it("records a beat for a registered job with a valid token", async () => {
    const { env, store } = envWith();
    const res = await handleFetch(
      req("/internal/heartbeat/notification-drain", {
        method: "POST",
        headers: { authorization: "Bearer s3cret" },
      }),
      env,
    );
    expect(res.status).toBe(202);
    expect(JSON.parse(store.get(beatKey("notification-drain")) as string)).toMatchObject({
      ok: true,
    });
  });

  it("records an explicit failure when the job reports one", async () => {
    const { env, store } = envWith();
    await handleFetch(
      req("/internal/heartbeat/notification-drain?status=fail", {
        method: "POST",
        headers: { authorization: "Bearer s3cret" },
      }),
      env,
    );
    expect(JSON.parse(store.get(beatKey("notification-drain")) as string)).toMatchObject({
      ok: false,
    });
  });

  // An unauthenticated heartbeat lets anyone silence a dead job by reporting for it, which is worse
  // than having no heartbeat at all.
  it("refuses an unauthenticated or wrongly-authenticated report, and writes nothing", async () => {
    for (const headers of [
      undefined,
      { authorization: "Bearer wrong" },
      { authorization: "s3cret" },
    ]) {
      const { env, store } = envWith();
      const res = await handleFetch(
        req("/internal/heartbeat/notification-drain", { method: "POST", headers }),
        env,
      );
      expect(res.status).toBe(404); // 404, not 401 — never confirm what exists
      expect(store.size).toBe(0);
    }
  });

  it("refuses every report when no token is configured", async () => {
    const { env, store } = envWith({}, "");
    const res = await handleFetch(
      req("/internal/heartbeat/notification-drain", {
        method: "POST",
        headers: { authorization: "Bearer " },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(store.size).toBe(0);
  });

  // A typo'd id must not look like a successful report while the real job stays silent.
  it("rejects an unregistered job id even with a valid token", async () => {
    const { env, store } = envWith();
    const res = await handleFetch(
      req("/internal/heartbeat/not-a-real-job", {
        method: "POST",
        headers: { authorization: "Bearer s3cret" },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(store.size).toBe(0);
  });

  it("does not route path-traversal or oversized ids", async () => {
    const { env } = envWith();
    for (const bad of ["/internal/heartbeat/../../etc", "/internal/heartbeat/" + "a".repeat(200)]) {
      const res = await handleFetch(
        req(bad, { method: "POST", headers: { authorization: "Bearer s3cret" } }),
        env,
      );
      expect(res.status).toBe(404);
    }
  });

  it("does not accept a heartbeat over GET", async () => {
    const { env, store } = envWith();
    const res = await handleFetch(
      req("/internal/heartbeat/notification-drain", {
        headers: { authorization: "Bearer s3cret" },
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(store.size).toBe(0);
  });
});

describe("GET /component/jobs", () => {
  it("is 200 while every job has reported recently", async () => {
    const { env } = envWith(freshBeats());
    const res = await handleFetch(req("/component/jobs"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"status":"pass"}');
  });

  it("is 503 when a job goes silent", async () => {
    const beats = freshBeats();
    beats[beatKey("auth-expiry-sweep")] = JSON.stringify({ ts: 0, ok: true });
    const { env } = envWith(beats);
    const res = await handleFetch(req("/component/jobs"), env);
    expect(res.status).toBe(503);
  });

  it("is 503 on a cold store, because no evidence is not the same as healthy", async () => {
    const { env } = envWith();
    expect((await handleFetch(req("/component/jobs"), env)).status).toBe(503);
  });

  // The public component must not enumerate our internal job names to an anonymous caller.
  it("names no job in the public response body", async () => {
    const beats = freshBeats();
    beats[beatKey("auth-expiry-sweep")] = JSON.stringify({ ts: 0, ok: true });
    const { env } = envWith(beats);
    const body = await (await handleFetch(req("/component/jobs"), env)).text();
    for (const j of REGISTERED_JOBS) expect(body).not.toContain(j.id);
  });
});
