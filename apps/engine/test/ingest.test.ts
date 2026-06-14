import { describe, expect, it } from "vitest";

import {
  handleIngest,
  type IngestDeps,
  type IngestRow,
  type VerifyIngestInput,
} from "../src/ingest";

const ORG = "be000000-0000-4000-8000-000000000001";
const EP = "be000000-0000-4000-8000-000000000002";
const GOOD = "whep_good-token";

interface Calls {
  put: { key: string; body: Uint8Array; contentType: string | null }[];
  ingest: IngestRow[];
  verify: VerifyIngestInput[];
  logs: { event: string; fields: Record<string, unknown> }[];
  order: string[];
}

function makeDeps(over: Partial<IngestDeps> = {}): { deps: IngestDeps; calls: Calls } {
  const calls: Calls = { put: [], ingest: [], verify: [], logs: [], order: [] };
  const deps: IngestDeps = {
    resolve: async (token) =>
      token === GOOD ? { orgId: ORG, endpointId: EP, paused: false, sealedSecrets: [] } : null,
    verify: async (input) => {
      calls.order.push("verify");
      calls.verify.push(input);
      return { verified: false, verification: null };
    },
    putPayload: async (key, body, contentType) => {
      calls.order.push("put");
      calls.put.push({ key, body, contentType });
    },
    ingestEvent: async (row) => {
      calls.order.push("ingest");
      calls.ingest.push(row);
      return { inserted: true };
    },
    now: () => new Date("2026-06-14T12:00:00Z"),
    log: (event, fields) => calls.logs.push({ event, fields }),
    maxBodyBytes: 1024 * 1024,
    dedupBucketWidthMs: 24 * 60 * 60 * 1000,
    ...over,
  };
  return { deps, calls };
}

function req(
  token: string,
  opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
) {
  const method = opts.method ?? "POST";
  return new Request(`https://wbhk.my/${token}`, {
    method,
    body: method === "GET" || method === "HEAD" ? undefined : (opts.body ?? `{"hello":"world"}`),
    headers: opts.headers ?? { "content-type": "application/json" },
  });
}

describe("handleIngest — the wbhk.my write path", () => {
  it("rejects a non-POST method with 405 (Allow: POST) and writes nothing", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(req(GOOD, { method: "GET" }), deps);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toMatch(/POST/i);
    expect(calls.put).toHaveLength(0);
    expect(calls.ingest).toHaveLength(0);
  });

  it("returns 404 for an unknown token, with no hints and nothing written", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(req("whep_nope"), deps);
    expect(res.status).toBe(404);
    expect(calls.put).toHaveLength(0);
    expect(calls.ingest).toHaveLength(0);
  });

  it("returns 404 for an empty path token", async () => {
    const { deps } = makeDeps();
    const res = await handleIngest(
      new Request("https://wbhk.my/", { method: "POST", body: "{}" }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("returns 429 + Retry-After for a paused endpoint (founder decision: reject, don't drop)", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({ orgId: ORG, endpointId: EP, paused: true, sealedSecrets: [] }),
    });
    const res = await handleIngest(req(GOOD), deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(calls.put).toHaveLength(0); // a paused endpoint captures nothing
    expect(calls.ingest).toHaveLength(0);
  });

  it("returns 413 when Content-Length exceeds the cap (rejected before reading the body)", async () => {
    const { deps, calls } = makeDeps({ maxBodyBytes: 16 });
    const res = await handleIngest(
      req(GOOD, { body: "x".repeat(100), headers: { "content-length": "100" } }),
      deps,
    );
    expect(res.status).toBe(413);
    expect(calls.put).toHaveLength(0);
  });

  it("returns 413 when the actual body exceeds the cap (lying/absent Content-Length)", async () => {
    const { deps, calls } = makeDeps({ maxBodyBytes: 16 });
    const res = await handleIngest(req(GOOD, { body: "x".repeat(100) }), deps);
    expect(res.status).toBe(413);
    expect(calls.put).toHaveLength(0);
  });

  it("accepts a body exactly at the cap and rejects one byte over (boundary)", async () => {
    const atCap = makeDeps({ maxBodyBytes: 16 });
    const okRes = await handleIngest(req(GOOD, { body: "x".repeat(16) }), atCap.deps);
    expect(okRes.status).toBe(200);
    expect(atCap.calls.put).toHaveLength(1);

    const overCap = makeDeps({ maxBodyBytes: 16 });
    const tooBig = await handleIngest(req(GOOD, { body: "x".repeat(17) }), overCap.deps);
    expect(tooBig.status).toBe(413);
    expect(overCap.calls.put).toHaveLength(0);
  });

  it("PUT-first durable-before-ACK: R2 PUT happens BEFORE the metadata insert, then ACK 200", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      req(GOOD, {
        body: `{"id":"evt_abc"}`,
        headers: { "stripe-signature": "t=1,v1=x", "content-type": "application/json" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls.order).toEqual(["put", "verify", "ingest"]); // durable PUT, then verify, then insert
    // the insert carries the derived dedup + the captured fields
    const row = calls.ingest[0]!;
    expect(row.orgId).toBe(ORG);
    expect(row.endpointId).toBe(EP);
    expect(row.dedupStrategy).toBe("provider_event_id");
    expect(row.dedupKey).toBe("stripe:evt_abc");
    expect(row.provider).toBe("stripe");
    expect(row.payloadBytes).toBe(new TextEncoder().encode(`{"id":"evt_abc"}`).byteLength);
    expect(row.payloadR2Key).toBe(calls.put[0]!.key); // same key written to R2 and stored
    // cookieless, no CORS
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("verifies AFTER the durable R2 PUT and writes the outcome (verified + diagnostic) to the insert", async () => {
    const verification = { ok: true, keyId: "secret_0", scheme: "stripe" };
    const secret = {
      id: "sec-1",
      provider: "stripe",
      ciphertextB64: "AAAA",
      nonceB64: "AAAA",
      wrappedDekB64: "AAAA",
      kekRef: "local-dev-kek",
      envelopeVersion: 1,
      context: { orgId: ORG, endpointId: EP, keyId: "sec-1" },
    } as const;
    const { deps, calls } = makeDeps({
      resolve: async () => ({ orgId: ORG, endpointId: EP, paused: false, sealedSecrets: [secret] }),
      verify: async (input) => {
        calls.order.push("verify");
        calls.verify.push(input);
        return { verified: true, verification };
      },
    });
    const res = await handleIngest(
      req(GOOD, {
        body: `{"id":"evt_abc"}`,
        headers: { "stripe-signature": "t=1,v1=x", "content-type": "application/json" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    // durable-before-verify: the body is durable (R2) before we spend verify cycles, then insert.
    expect(calls.order).toEqual(["put", "verify", "ingest"]);
    // verify got the raw bytes, the detected provider, the authoritative org/endpoint, and the secrets.
    const vin = calls.verify[0]!;
    expect(vin.provider).toBe("stripe");
    expect(vin.orgId).toBe(ORG);
    expect(vin.endpointId).toBe(EP);
    expect(vin.sealedSecrets).toEqual([secret]);
    expect(new TextDecoder().decode(vin.rawBody)).toBe(`{"id":"evt_abc"}`);
    // the outcome is persisted on the event row
    const row = calls.ingest[0]!;
    expect(row.verified).toBe(true);
    expect(row.verification).toEqual(verification);
  });

  it("a thrown verify never blocks capture: the event is still stored (verified=false) and ACKed 200", async () => {
    const { deps, calls } = makeDeps({
      verify: async () => {
        throw new Error("kms down");
      },
    });
    const res = await handleIngest(req(GOOD), deps);
    expect(res.status).toBe(200);
    expect(calls.ingest).toHaveLength(1); // captured despite the verify failure
    expect(calls.ingest[0]!.verified).toBe(false);
    expect(calls.ingest[0]!.verification).toBeNull();
  });

  it("a dedup no-op (inserted=false) still ACKs 200", async () => {
    const { deps } = makeDeps({ ingestEvent: async () => ({ inserted: false }) });
    const res = await handleIngest(req(GOOD), deps);
    expect(res.status).toBe(200);
  });

  it("if the R2 PUT fails, it does NOT insert metadata and returns 500 (never ACK an undurable event)", async () => {
    const { deps, calls } = makeDeps({
      putPayload: async () => {
        throw new Error("r2 down");
      },
    });
    const res = await handleIngest(req(GOOD), deps);
    expect(res.status).toBe(500);
    expect(calls.ingest).toHaveLength(0); // body not durable -> never write the row
  });

  it("if the metadata insert fails, returns 500 (the R2 object survives for the orphan sweep)", async () => {
    const { deps, calls } = makeDeps({
      ingestEvent: async () => {
        throw new Error("db down");
      },
    });
    const res = await handleIngest(req(GOOD), deps);
    expect(res.status).toBe(500);
    expect(calls.put).toHaveLength(1); // R2 object was written before the failed insert
  });

  it("never logs a signature header verbatim (scrubbed log boundary)", async () => {
    const { deps, calls } = makeDeps();
    await handleIngest(
      req(GOOD, {
        headers: { "stripe-signature": "t=1,v1=SECRETSIG", "content-type": "application/json" },
      }),
      deps,
    );
    const logged = JSON.stringify(calls.logs);
    expect(logged).not.toContain("SECRETSIG");
  });
});
