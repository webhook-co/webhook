import { describe, expect, it } from "vitest";

import { receiptKey } from "./canary";
import { handleFetch, handleSink, type Env } from "./index";

function envWith(seed: Record<string, string> = {}, sinkSecret = "sink-s3cret") {
  const map = new Map(Object.entries(seed));
  const env = {
    HEALTH_KV: {
      get: async (k: string) => map.get(k) ?? null,
      put: async (k: string, v: string) => void map.set(k, v),
    },
    HEARTBEAT_TOKEN: "hb",
    CANARY_SINK_SECRET: sinkSecret,
  } as unknown as Env;
  return { env, map };
}

const post = (body: unknown, secret?: string) =>
  new Request("https://health.wbhk.my/sink", {
    method: "POST",
    body: JSON.stringify(body),
    headers: secret === undefined ? {} : { "x-canary-secret": secret },
  });

describe("POST /sink", () => {
  it("records a receipt for an authenticated delivery", async () => {
    const { env, map } = envWith();
    const res = await handleSink(post({ nonce: "abc12345" }, "sink-s3cret"), env);
    expect(res.status).toBe(202);
    expect(map.get(receiptKey("abc12345"))).toBeDefined();
  });

  // A forgeable receipt reports a HEALTHY delivery pipeline while it is actually broken — the worst
  // possible failure for this component, because it is silent.
  it("refuses an unauthenticated or wrong secret, and records nothing", async () => {
    for (const secret of [undefined, "wrong"]) {
      const { env, map } = envWith();
      const res = await handleSink(post({ nonce: "abc12345" }, secret), env);
      expect(res.status).toBe(404);
      expect(map.size).toBe(0);
    }
  });

  it("refuses everything when no sink secret is configured", async () => {
    const { env, map } = envWith({}, "");
    expect((await handleSink(post({ nonce: "abc12345" }, ""), env)).status).toBe(404);
    expect(map.size).toBe(0);
  });

  it("rejects a malformed or missing nonce rather than writing a junk key", async () => {
    for (const body of [{}, { nonce: 42 }, { nonce: "short" }, { nonce: "../../etc/passwd" }]) {
      const { env, map } = envWith();
      const res = await handleSink(post(body, "sink-s3cret"), env);
      expect(res.status).toBe(404);
      expect(map.size).toBe(0);
    }
  });

  it("rejects a non-JSON body without throwing", async () => {
    const { env } = envWith();
    const res = await handleSink(
      new Request("https://health.wbhk.my/sink", {
        method: "POST",
        body: "not json",
        headers: { "x-canary-secret": "sink-s3cret" },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /component/delivery", () => {
  it("is 503 before any round-trip has ever completed", async () => {
    const { env } = envWith();
    const res = await handleFetch(new Request("https://health.wbhk.my/component/delivery"), env);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('{"status":"fail"}');
  });

  it("is 200 once a recent success is recorded", async () => {
    const { env } = envWith({
      "canary:state": JSON.stringify({ inFlight: null, lastSuccessAt: Date.now() }),
    });
    const res = await handleFetch(new Request("https://health.wbhk.my/component/delivery"), env);
    expect(res.status).toBe(200);
  });

  it("is 503 again once that success goes stale", async () => {
    const { env } = envWith({
      "canary:state": JSON.stringify({
        inFlight: null,
        lastSuccessAt: Date.now() - 60 * 60 * 1000,
      }),
    });
    const res = await handleFetch(new Request("https://health.wbhk.my/component/delivery"), env);
    expect(res.status).toBe(503);
  });
});
