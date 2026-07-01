import { serializeVerifyTokenSecret } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import {
  handleIngest,
  type AutoDeliverArgs,
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
  autoDeliver: AutoDeliverArgs[];
}

function makeDeps(over: Partial<IngestDeps> = {}): { deps: IngestDeps; calls: Calls } {
  const calls: Calls = { put: [], ingest: [], verify: [], logs: [], order: [], autoDeliver: [] };
  const deps: IngestDeps = {
    resolve: async (token) =>
      token === GOOD ? { orgId: ORG, endpointId: EP, paused: false, sealedSecrets: [] } : null,
    verify: async (input) => {
      calls.order.push("verify");
      calls.verify.push(input);
      return { verified: false, verification: null };
    },
    unsealSecret: async () => "fake-unsealed-secret",
    putPayload: async (key, body, contentType) => {
      calls.order.push("put");
      calls.put.push({ key, body, contentType });
    },
    ingestEvent: async (row) => {
      calls.order.push("ingest");
      calls.ingest.push(row);
      return { inserted: true };
    },
    autoDeliver: async (args) => {
      calls.order.push("autoDeliver");
      calls.autoDeliver.push(args);
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
      expect(res.headers.get("x-content-type-options")).toBe("nosniff"); // nosniff rides every response shape
      expect(calls.order).toEqual(["put", "verify", "ingest", "autoDeliver"]); // capture, then route
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
    expect(res.headers.get("x-content-type-options")).toBe("nosniff"); // nosniff on the 405 error response too
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
    expect(calls.order).toEqual(["put", "verify", "ingest", "autoDeliver"]); // PUT, verify, insert, route
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
    expect(row.eventType).toBeNull(); // this stripe body carries no `.type` → unextracted (routes via `*`)
    // cookieless, no CORS
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("derives + stores the per-provider event_type (S3 Slice 3): stripe body `.type`, github header", async () => {
    const stripe = makeDeps();
    await handleIngest(
      new Request(`https://wbhk.my/${GOOD}`, {
        method: "POST",
        body: `{"type":"charge.succeeded","id":"evt_t"}`,
        headers: { "stripe-signature": "t=1,v1=x", "content-type": "application/json" },
      }),
      stripe.deps,
    );
    expect(stripe.calls.ingest[0]!.eventType).toBe("charge.succeeded");

    const github = makeDeps();
    await handleIngest(
      new Request(`https://wbhk.my/${GOOD}`, {
        method: "POST",
        body: `{}`,
        headers: { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=x" },
      }),
      github.deps,
    );
    expect(github.calls.ingest[0]!.eventType).toBe("pull_request");
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
    // durable-before-verify: the body is durable (R2) before we spend verify cycles, then insert, then route.
    expect(calls.order).toEqual(["put", "verify", "ingest", "autoDeliver"]);
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

  // ── Native auto-delivery (S3 Slice 3 PR2c): a genuinely-new event triggers subscription resolution +
  // durable enqueue, AFTER the event is durable, best-effort (never blocks the capture ACK). ───────────
  it("invokes autoDeliver AFTER the durable insert, with the new event's id/provider/type/verified", async () => {
    const { deps, calls } = makeDeps({
      verify: async () => ({ verified: true, verification: null, provider: "stripe" }),
    });
    const res = await handleIngest(
      req(GOOD, {
        body: `{"type":"charge.succeeded"}`,
        headers: { "content-type": "application/json" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    // Auto-delivery is the LAST step and runs strictly AFTER the durable insert (the event is the floor).
    expect(calls.order.at(-1)).toBe("autoDeliver");
    expect(calls.order.indexOf("autoDeliver")).toBeGreaterThan(calls.order.indexOf("ingest"));
    expect(calls.autoDeliver).toHaveLength(1);
    const args = calls.autoDeliver[0]!;
    expect(args.orgId).toBe(ORG);
    expect(args.sourceEndpointId).toBe(EP);
    // The eventId handed to auto-delivery is the SAME id written to the events row (the new event's id).
    expect(args.event.eventId).toBe(calls.ingest[0]!.id);
    expect(args.event.provider).toBe("stripe"); // the AUTHORITATIVE (verify-named) provider
    expect(args.event.eventType).toBe("charge.succeeded"); // extracted from the stripe body `type`
    expect(args.event.verified).toBe(true);
  });

  it("does NOT auto-deliver on a dedup no-op (inserted=false) — the original event already enqueued", async () => {
    const { deps, calls } = makeDeps({ ingestEvent: async () => ({ inserted: false }) });
    const res = await handleIngest(req(GOOD), deps);
    expect(res.status).toBe(200);
    expect(calls.autoDeliver).toHaveLength(0);
  });

  it("routes a captured GET like any event (null provider/type so only match-any subs deliver)", async () => {
    // Accept-all-verbs: a GET is captured AS an event, so it is eligible for delivery — the subscription
    // matcher (provider / event_type / require_verified) is what decides, not the verb. A browser GET carries
    // no signature, so it routes with provider null + eventType null (matches only a wide-open `*` sub).
    const { deps, calls } = makeDeps();
    await handleIngest(req(GOOD, { method: "GET" }), deps);
    expect(calls.ingest).toHaveLength(1);
    expect(calls.autoDeliver).toHaveLength(1);
    expect(calls.autoDeliver[0]!.event).toMatchObject({
      provider: null,
      eventType: null,
      verified: false,
    });
  });

  it("a thrown autoDeliver is swallowed — capture still ACKs 200 (best-effort, never blocks the floor)", async () => {
    const { deps, calls } = makeDeps({
      autoDeliver: async () => {
        throw new Error("delivery DB down");
      },
    });
    const res = await handleIngest(req(GOOD), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(calls.ingest).toHaveLength(1); // the event is durable regardless
    expect(calls.logs.some((l) => l.event === "ingest.autodeliver_failed")).toBe(true);
  });

  it("defers auto-delivery PAST the ACK via waitUntil — capture returns without blocking on delivery", async () => {
    // Production wires deps.waitUntil to ctx.waitUntil so auto-delivery runs after the response is sent.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let autoDeliverCalled = false;
    let autoDeliverDone = false;
    const deferred: Promise<unknown>[] = [];
    const { deps } = makeDeps({
      autoDeliver: async () => {
        autoDeliverCalled = true;
        await gate; // a slow/stuck delivery subsystem must NOT hold up the capture ACK
        autoDeliverDone = true;
      },
      waitUntil: (p) => {
        deferred.push(p);
      },
    });

    const res = await handleIngest(req(GOOD), deps);
    expect(res.status).toBe(200);
    expect(autoDeliverCalled).toBe(true); // scheduled…
    expect(deferred).toHaveLength(1); // …handed to waitUntil, NOT awaited inline
    expect(autoDeliverDone).toBe(false); // capture ACKed before delivery finished (decoupled)

    release(); // the runtime keeps the isolate alive until the waitUntil task settles
    await Promise.all(deferred);
    expect(autoDeliverDone).toBe(true);
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

describe("handleIngest — GET verification-handshake dispatch (no-secret protocols, PR1)", () => {
  it("echoes a ?challenge= GET (Dropbox/Adobe) and captures NOTHING (pre-capture control message)", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?challenge=abc123`, { method: "GET" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(calls.put).toHaveLength(0); // nothing stored
    expect(calls.ingest).toHaveLength(0); // nothing metered
    expect(calls.verify).toHaveLength(0);
  });

  it("completes a ?challenge= handshake even on a PAUSED endpoint (subscription setup, not an event)", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => ({ orgId: ORG, endpointId: EP, paused: true, sealedSecrets: [] }),
    });
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?challenge=abc123`, { method: "GET" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
    expect(calls.ingest).toHaveLength(0);
  });

  it("a handshake to an UNKNOWN token still 404s (resolve runs before the dispatcher — no oracle change)", async () => {
    const { deps } = makeDeps();
    const res = await handleIngest(
      new Request(`https://wbhk.my/whep_nope?challenge=abc123`, { method: "GET" }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("a normal GET (no challenge param) is NOT diverted — it captures + returns liveness (Slice 1 unchanged)", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(new Request(`https://wbhk.my/${GOOD}`, { method: "GET" }), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/live/i);
    expect(calls.ingest).toHaveLength(1); // captured (bill-all), method recorded
    expect(calls.ingest[0]!.method).toBe("GET");
  });

  it("echoes an Adobe Sign X-AdobeSign-ClientId GET and captures nothing", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}`, {
        method: "GET",
        headers: { "x-adobesign-clientid": "client-xyz" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-adobesign-clientid")).toBe("client-xyz");
    expect(calls.ingest).toHaveLength(0);
  });
});

describe("handleIngest — GET verification-handshake dispatch (X/Twitter CRC, PR2a)", () => {
  // A `crc_token` GET on an endpoint with an `x` secret unseals it (pre-capture) and HMACs the token.
  const X_ENDPOINT = {
    orgId: ORG,
    endpointId: EP,
    paused: false,
    sealedSecrets: [{ provider: "x" }],
  };
  const CONSUMER_SECRET = "z3ZX4v7mAAUGykl3EcmkqbartmuW8VFOOzCloLx9Q45P0hLrFu"; // gitleaks:allow — fake test fixture

  it("a crc_token GET unseals the `x` secret, returns the HMAC response_token (gold vector), captures NOTHING", async () => {
    const unsealed: unknown[] = [];
    const { deps, calls } = makeDeps({
      resolve: async () => X_ENDPOINT as never,
      unsealSecret: async (cached, orgId, endpointId) => {
        unsealed.push({ provider: (cached as { provider: string }).provider, orgId, endpointId });
        return CONSUMER_SECRET;
      },
    });
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?crc_token=9b4507b3-9040-4669-9ca3-6b94edb50553`, {
        method: "GET",
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      response_token: "sha256=Cytd4Sq+NvEcV3MMrXxWJGJx5A+y/lXzzU2Maartkx8=",
    });
    // unsealed the right endpoint's `x` secret with the AUTHORITATIVE org/endpoint as AAD
    expect(unsealed).toEqual([{ provider: "x", orgId: ORG, endpointId: EP }]);
    expect(calls.put).toHaveLength(0); // nothing stored
    expect(calls.ingest).toHaveLength(0); // nothing metered
  });

  it("a crc_token GET on an endpoint with NO `x` secret falls through to capture (not a resolvable handshake)", async () => {
    const { deps, calls } = makeDeps(); // default endpoint has sealedSecrets: []
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?crc_token=abc`, { method: "GET" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/live/i); // generic liveness, not a CRC response
    expect(calls.ingest).toHaveLength(1); // captured (bill-all)
  });

  it("a thrown unseal does NOT block the floor — it is caught and the GET falls through to capture", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => X_ENDPOINT as never,
      unsealSecret: async () => {
        throw new Error("KMS unavailable");
      },
    });
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?crc_token=9b4507b3`, { method: "GET" }),
      deps,
    );
    expect(res.status).toBe(200); // never a 500 — the no-drop floor is preserved
    expect(await res.text()).toMatch(/live/i); // fell through to liveness
    expect(calls.ingest).toHaveLength(1); // still captured
    // and it logged the failure (not silently swallowed)
    expect(calls.logs.some((l) => l.event === "ingest.handshake_failed")).toBe(true);
  });
});

describe("handleIngest — GET verification-handshake dispatch (Meta hub.challenge, PR2b)", () => {
  const META_ENDPOINT = {
    orgId: ORG,
    endpointId: EP,
    paused: false,
    sealedSecrets: [{ provider: "meta" }],
  };
  const VERIFY_TOKEN = "my-meta-hub-verify-token";
  const metaReq = (challenge: string, verifyToken: string) =>
    new Request(
      `https://wbhk.my/${GOOD}?hub.mode=subscribe&hub.challenge=${challenge}&hub.verify_token=${verifyToken}`,
      { method: "GET" },
    );

  it("a matching verify-token echoes hub.challenge (200) and captures NOTHING", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => META_ENDPOINT as never,
      unsealSecret: async () => serializeVerifyTokenSecret(VERIFY_TOKEN),
    });
    const res = await handleIngest(metaReq("CHALLENGE_42", VERIFY_TOKEN), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CHALLENGE_42");
    expect(calls.put).toHaveLength(0);
    expect(calls.ingest).toHaveLength(0); // a control message, never metered
  });

  it("a MISMATCHED verify-token returns 403 and captures NOTHING (no echo)", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => META_ENDPOINT as never,
      unsealSecret: async () => serializeVerifyTokenSecret(VERIFY_TOKEN),
    });
    const res = await handleIngest(metaReq("CHALLENGE_42", "wrong-token"), deps);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("CHALLENGE_42");
    expect(calls.ingest).toHaveLength(0); // 403 is pre-capture too
  });

  it("an endpoint with NO meta verify-token falls through to capture (only an app-secret configured)", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => META_ENDPOINT as never,
      unsealSecret: async () => "raw-meta-app-secret-not-a-blob",
    });
    const res = await handleIngest(metaReq("CHALLENGE_42", VERIFY_TOKEN), deps);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/live/i); // generic liveness, not the challenge echo
    expect(calls.ingest).toHaveLength(1); // captured (bill-all)
  });
});

describe("handleIngest — GET verification-handshake dispatch (eBay challenge_code, PR3)", () => {
  const EBAY_ENDPOINT = {
    orgId: ORG,
    endpointId: EP,
    paused: false,
    sealedSecrets: [{ provider: "ebay" }],
  };

  it("answers a challenge_code GET with a SHA-256 challengeResponse and captures NOTHING", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => EBAY_ENDPOINT as never,
      unsealSecret: async () => serializeVerifyTokenSecret("ebay-verify-token-abc"),
    });
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?challenge_code=71745723`, { method: "GET" }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challengeResponse: string };
    expect(body.challengeResponse).toMatch(/^[0-9a-f]{64}$/); // lowercase hex SHA-256
    expect(calls.put).toHaveLength(0);
    expect(calls.ingest).toHaveLength(0); // a control message, never metered
  });

  it("an endpoint with NO ebay verify-token falls through to capture (only app-creds configured)", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () => EBAY_ENDPOINT as never,
      unsealSecret: async () => JSON.stringify({ clientId: "c", clientSecret: "s" }),
    });
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?challenge_code=71745723`, { method: "GET" }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/live/i); // generic liveness, not a challengeResponse
    expect(calls.ingest).toHaveLength(1); // captured (bill-all)
  });
});

describe("handleIngest — POST subscription-validation handshakes (Graph/Twitch/monday, S8 Slice 3)", () => {
  it("echoes a Microsoft Graph ?validationToken POST as text/plain and captures NOTHING", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?validationToken=GraphValidate123`, {
        method: "POST",
        body: "",
        headers: { "content-type": "text/plain" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("GraphValidate123");
    expect(calls.put).toHaveLength(0); // pre-capture: nothing stored
    expect(calls.ingest).toHaveLength(0); // nothing metered
  });

  it("echoes a monday {challenge} POST as JSON and captures NOTHING", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}`, {
        method: "POST",
        body: JSON.stringify({ challenge: "monday-xyz" }),
        headers: { "content-type": "application/json" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "monday-xyz" });
    expect(calls.ingest).toHaveLength(0);
  });

  it("a normal POST event (no handshake signal) is still captured, not diverted", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}`, {
        method: "POST",
        body: JSON.stringify({ id: "evt_1", data: { ok: true } }),
        headers: { "content-type": "application/json" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(calls.ingest).toHaveLength(1); // captured (bill-all)
  });

  it("Zoom endpoint.url_validation: responds with the HMAC encryptedToken and captures NOTHING", async () => {
    const { deps, calls } = makeDeps({
      resolve: async () =>
        ({
          orgId: ORG,
          endpointId: EP,
          paused: false,
          sealedSecrets: [{ provider: "zoom" }],
        }) as never,
      unsealSecret: async () => "zoom-secret-token-xyz", // gitleaks:allow — fake test fixture
    });
    const res = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}`, {
        method: "POST",
        body: JSON.stringify({
          event: "endpoint.url_validation",
          payload: { plainToken: "pv-plainToken-abc123" },
        }),
        headers: { "content-type": "application/json" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      plainToken: "pv-plainToken-abc123",
      encryptedToken: "924c76d973084bbe133c17ff1c1a9b6639c74aef8bb34daa05c70361039e7beb", // gitleaks:allow — HMAC test output
    });
    expect(calls.put).toHaveLength(0);
    expect(calls.ingest).toHaveLength(0); // pre-capture, never metered
  });

  it("a GET carrying ?validationToken= is POST-only-gated: NOT echoed — captured + constant liveness (no oracle)", async () => {
    const active = makeDeps();
    const resActive = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?validationToken=probe`, { method: "GET" }),
      active.deps,
    );
    expect(resActive.status).toBe(200);
    const bodyActive = await resActive.text();
    expect(bodyActive).not.toContain("probe"); // POST-only: a GET never echoes the Graph validationToken
    expect(bodyActive).toMatch(/live/i); // normal GET liveness
    expect(active.calls.ingest).toHaveLength(1); // captured, not diverted

    // a PAUSED endpoint answers the SAME liveness — the validationToken param leaks no paused/active signal
    const paused = makeDeps({
      resolve: async () => ({ orgId: ORG, endpointId: EP, paused: true, sealedSecrets: [] }),
    });
    const resPaused = await handleIngest(
      new Request(`https://wbhk.my/${GOOD}?validationToken=probe`, { method: "GET" }),
      paused.deps,
    );
    expect(await resPaused.text()).toBe(bodyActive); // byte-identical -> no oracle
    expect(paused.calls.ingest).toHaveLength(0);
  });
});
