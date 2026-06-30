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
  const bodiless = method === "GET" || method === "HEAD" || method === "OPTIONS";
  return new Request(`https://wbhk.my/${token}`, {
    method,
    body: bodiless ? undefined : (opts.body ?? `{"hello":"world"}`),
    headers: opts.headers ?? { "content-type": "application/json" },
  });
}

describe("handleIngest — the wbhk.my write path", () => {
  it("GET captures the request (method=GET) and returns a friendly liveness 200 + security headers", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(req(GOOD, { method: "GET" }), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/live/i); // friendly browser liveness, not a scary 405
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // accept-all-verbs (the inspector model): a GET IS captured + the method recorded
    expect(calls.put).toHaveLength(1);
    expect(calls.ingest).toHaveLength(1);
    expect(calls.ingest[0]!.method).toBe("GET");
    // still cookieless + no-CORS on the now-browser-facing response
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("HEAD returns 200 with a NULL body + security headers, captured with method=HEAD", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(req(GOOD, { method: "HEAD" }), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(""); // explicit null body (Workers does not auto-strip)
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(calls.ingest[0]!.method).toBe("HEAD");
  });

  it("OPTIONS returns 204 (no CORS) + security headers, captured with method=OPTIONS", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(req(GOOD, { method: "OPTIONS" }), deps);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull(); // no preflight; no-CORS
    expect(res.headers.get("access-control-allow-methods")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(calls.ingest[0]!.method).toBe("OPTIONS");
  });

  it.each(["PUT", "PATCH", "DELETE"])(
    "%s with a body captures (durable-before-ACK), records the method, and ACKs 200 ok",
    async (method) => {
      const { deps, calls } = makeDeps();
      const res = await handleIngest(req(GOOD, { method, body: `{"v":1}` }), deps);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(calls.order).toEqual(["put", "verify", "ingest"]); // ordering unchanged for bodied verbs
      expect(calls.ingest[0]!.method).toBe(method);
      expect(calls.verify[0]!.method).toBe(method); // method forwarded to verify (Tier-2 url/method signers)
    },
  );

  it("rejects an UNSUPPORTED verb with 405 + the Allow list, even for an UNKNOWN token (pre-resolve, no oracle)", async () => {
    const { deps, calls } = makeDeps();
    // PURGE is a valid-but-unsupported verb; whep_nope is an unknown token. A pre-resolve gate returns a
    // uniform 405 regardless of token validity (a post-resolve gate would 404 here and leak existence).
    const res = await handleIngest(
      new Request("https://wbhk.my/whep_nope", { method: "PURGE" }),
      deps,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toMatch(/GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE/);
    expect(calls.put).toHaveLength(0); // never resolved, never captured
    expect(calls.ingest).toHaveLength(0);
  });

  it("GET liveness is byte-identical across two different resolved endpoints (constant — leaks nothing resolved)", async () => {
    const epA = makeDeps({
      resolve: async () => ({ orgId: ORG, endpointId: EP, paused: false, sealedSecrets: [] }),
    });
    const epB = makeDeps({
      resolve: async () => ({
        orgId: "be000000-0000-4000-8000-0000000000aa",
        endpointId: "be000000-0000-4000-8000-0000000000bb",
        paused: false,
        sealedSecrets: [],
      }),
    });
    const resA = await handleIngest(req(GOOD, { method: "GET" }), epA.deps);
    const resB = await handleIngest(req("whep_other", { method: "GET" }), epB.deps);
    expect(await resA.text()).toBe(await resB.text());
    expect([...resA.headers].sort()).toEqual([...resB.headers].sort());
  });

  it("a GET to a PAUSED endpoint returns the constant liveness 200 and captures nothing (paused not observable via GET)", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({ orgId: ORG, endpointId: EP, paused: true, sealedSecrets: [] }),
    });
    const res = await handleIngest(req(GOOD, { method: "GET" }), deps);
    // identical to an active endpoint's GET — a browser GET never reveals the paused/active distinction
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/live/i);
    // paused: a liveness verb captures + bills NOTHING (write verbs still get a retryable 429)
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
    expect(row.method).toBe("POST");
    expect(row.dedupStrategy).toBe("provider_event_id");
    expect(row.dedupKey).toBe("stripe:evt_abc");
    expect(row.provider).toBe("stripe");
    expect(row.payloadBytes).toBe(new TextEncoder().encode(`{"id":"evt_abc"}`).byteLength);
    expect(row.payloadR2Key).toBe(calls.put[0]!.key); // same key written to R2 and stored
    // cookieless, no CORS
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("forwards the full request URL + method to verify (F3: Tier-2 url/method-signed providers)", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?id=42&topic=orders`, {
        method: "POST",
        body: `{"id":"evt_url"}`,
        headers: { "content-type": "application/json" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls.verify[0]!.requestUrl).toBe(`https://wbhk.my/${GOOD}?id=42&topic=orders`);
    expect(calls.verify[0]!.method).toBe("POST");
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

describe("handleIngest — Slack url_verification handshake (Slice C)", () => {
  // Slack POSTs these headers on a (signed) Request URL verification; their presence makes
  // detectScheme resolve the request to the slack scheme — the gate that confines the JSON parse.
  const SLACK = {
    "x-slack-signature": "v0=abc",
    "x-slack-request-timestamp": "1700000000",
    "content-type": "application/json",
  };

  it("echoes the challenge (200 JSON {challenge}) for a slack url_verification, capturing NOTHING", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      req(GOOD, {
        body: `{"token":"Jhj5","challenge":"3eZbrw1a","type":"url_verification"}`,
        headers: SLACK,
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ challenge: "3eZbrw1a" });
    // Pre-capture echo: nothing durable, nothing verified, nothing stored — it's a control message.
    expect(calls.put).toHaveLength(0);
    expect(calls.verify).toHaveLength(0);
    expect(calls.ingest).toHaveLength(0);
    // cookieless, no CORS (same posture as every wbhk.my response)
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("captures a normal slack EVENT (not url_verification) — the handshake is type-gated", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      req(GOOD, {
        body: `{"type":"event_callback","event":{"type":"message"}}`,
        headers: SLACK,
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls.put).toHaveLength(1); // captured normally
    expect(calls.ingest).toHaveLength(1);
    expect(calls.ingest[0]!.provider).toBe("slack");
  });

  it("a non-JSON slack body falls through to normal capture (the no-drop floor is never at risk)", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(req(GOOD, { body: `not json{`, headers: SLACK }), deps);
    expect(res.status).toBe(200);
    expect(calls.put).toHaveLength(1); // still captured
    expect(calls.ingest).toHaveLength(1);
  });

  it("a url_verification body WITHOUT slack headers is captured, NOT echoed (handshake confined to slack)", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      req(GOOD, {
        body: `{"type":"url_verification","challenge":"3eZbrw1a"}`,
        headers: { "content-type": "application/json" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls.put).toHaveLength(1); // a non-slack sender's body is a normal event, captured
    expect(calls.ingest).toHaveLength(1);
  });

  it("a url_verification with a non-string challenge falls through to capture (shape-gated)", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      req(GOOD, { body: `{"type":"url_verification","challenge":123}`, headers: SLACK }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls.put).toHaveLength(1);
    expect(calls.ingest).toHaveLength(1);
  });

  it("a url_verification with an EMPTY challenge falls through to capture (not a real handshake)", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      req(GOOD, { body: `{"type":"url_verification","challenge":""}`, headers: SLACK }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls.put).toHaveLength(1); // captured, not echoed — an empty challenge is degenerate
    expect(calls.ingest).toHaveLength(1);
  });

  it("a slack event_callback carrying an event_id is captured (the handshake parse is skipped)", async () => {
    // event_id present -> deriveDedup sets providerEventId -> the handshake branch is skipped entirely.
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      req(GOOD, {
        body: `{"type":"event_callback","event_id":"Ev0001","event":{"type":"message"}}`,
        headers: SLACK,
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(calls.put).toHaveLength(1);
    expect(calls.ingest).toHaveLength(1);
    expect(calls.ingest[0]!.provider).toBe("slack");
    expect(calls.ingest[0]!.dedupStrategy).toBe("provider_event_id");
  });
});
