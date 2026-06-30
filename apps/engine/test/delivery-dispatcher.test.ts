import {
  generateSigningSecret,
  LocalKmsProvider,
  payloadR2Key,
  SecretStore,
  standardWebhooksAdapter,
} from "@webhook-co/shared";
import { describe, expect, it, vi } from "vitest";

import {
  guardedDeliver,
  makeSignDelivery,
  resolveViaDoh,
  type DeliverArgs,
  type DeliverDeps,
} from "../src/delivery-dispatcher";

// The engine's server-side remote delivery + its AUTHORITATIVE connect-time SSRF guard (ADR-0081),
// exercised in the real Workers runtime (workerd). guardedDeliver takes injected deps (R2 read / DoH
// resolve / fetch) so the whole guard pipeline — structural reject, resolve-and-validate every IP,
// fail-closed, the H1 key re-derivation, redirect:manual, the header filter — is provable with fakes.

const ARGS: DeliverArgs = {
  orgId: "11111111-1111-4111-8111-111111111111",
  endpointId: "22222222-2222-4222-8222-222222222222",
  dedupKey: "dedup-1",
  url: "https://hooks.example.com/in",
  headers: [
    ["Host", "wbhk.my"],
    ["Webhook-Id", "msg_1"],
    ["Content-Type", "application/json"],
  ],
};
const BODY = new TextEncoder().encode('{"hello":"world"}');

function deps(over: Partial<DeliverDeps> = {}): DeliverDeps & {
  fetchMock: ReturnType<typeof vi.fn>;
  getPayloadMock: ReturnType<typeof vi.fn>;
} {
  let t = 0;
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  const getPayloadMock = vi.fn(async () => BODY.buffer.slice(0) as ArrayBuffer);
  return {
    getPayload: getPayloadMock as DeliverDeps["getPayload"],
    resolve: async () => ["93.184.216.34"],
    fetch: fetchMock as unknown as typeof fetch,
    now: () => (t += 5),
    ...over,
    fetchMock,
    getPayloadMock,
  };
}

describe("guardedDeliver — connect-time SSRF guard", () => {
  it("blocks a structurally-invalid url (non-https) WITHOUT resolving or fetching", async () => {
    const d = deps();
    const r = await guardedDeliver(d, { ...ARGS, url: "http://hooks.example.com/in" });
    expect(r.outcome).toBe("blocked");
    expect(d.fetchMock).not.toHaveBeenCalled();
    expect(d.getPayloadMock).not.toHaveBeenCalled();
  });

  it("blocks when the host resolves to a private / loopback / metadata address", async () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1"]) {
      const d = deps({ resolve: async () => [ip] });
      const r = await guardedDeliver(d, ARGS);
      expect(r.outcome, ip).toBe("blocked");
      expect(d.fetchMock, ip).not.toHaveBeenCalled();
    }
  });

  it("blocks if ANY resolved address is private (mixed public+private)", async () => {
    const d = deps({ resolve: async () => ["93.184.216.34", "10.1.2.3"] });
    const r = await guardedDeliver(d, ARGS);
    expect(r.outcome).toBe("blocked");
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it("a DNS error / no-address resolve is a RETRYABLE 'failed' (still fails closed — never fetches)", async () => {
    const thrown = deps({
      resolve: async () => {
        throw new Error("doh down");
      },
    });
    const rThrown = await guardedDeliver(thrown, ARGS);
    expect(rThrown.outcome).toBe("failed"); // transient infra, not a terminal SSRF 'blocked'
    expect(thrown.fetchMock).not.toHaveBeenCalled(); // but security holds: no fetch on an unresolved host
    const empty = deps({ resolve: async () => [] });
    const rEmpty = await guardedDeliver(empty, ARGS);
    expect(rEmpty.outcome).toBe("failed");
    expect(empty.fetchMock).not.toHaveBeenCalled();
  });

  it("delivers to a public destination: re-derives the R2 key (H1), filters headers, no-follow", async () => {
    const d = deps();
    const r = await guardedDeliver(d, ARGS);
    expect(r.outcome).toBe("delivered");
    expect(r.status).toBe(200);
    // H1: the payload is read by the RE-DERIVED key, never a handed key.
    const expectedKey = await payloadR2Key(ARGS.orgId, ARGS.endpointId, ARGS.dedupKey);
    expect(d.getPayloadMock).toHaveBeenCalledWith(expectedKey);
    // the POST: canonical url, manual redirect, filtered headers (host dropped, webhook-* kept).
    expect(d.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = d.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/in");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    const h = new Headers(init.headers);
    expect(h.get("host")).toBeNull();
    expect(h.get("webhook-id")).toBe("msg_1");
  });

  it("records a non-2xx as failed (with the status) and never follows a 3xx", async () => {
    const five = deps({
      fetch: vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
    });
    const r5 = await guardedDeliver(five, ARGS);
    expect(r5.outcome).toBe("failed");
    expect(r5.status).toBe(500);
    const threexx = deps({
      fetch: vi.fn(
        async () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/" } }),
      ) as unknown as typeof fetch,
    });
    const r3 = await guardedDeliver(threexx, ARGS);
    expect(r3.outcome).toBe("failed");
    expect(r3.status).toBe(302);
  });

  it("records a connection failure as failed (status null), never a throw", async () => {
    const d = deps({
      fetch: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const r = await guardedDeliver(d, ARGS);
    expect(r.outcome).toBe("failed");
    expect(r.status).toBeNull();
  });

  it("fails (not blocked) when the payload object is missing, without fetching", async () => {
    const d = deps({ getPayload: vi.fn(async () => null) as DeliverDeps["getPayload"] });
    const r = await guardedDeliver(d, ARGS);
    expect(r.outcome).toBe("failed");
    expect((d as ReturnType<typeof deps>).fetchMock).not.toHaveBeenCalled();
  });
});

describe("guardedDeliver — Standard Webhooks signing (S3 Slice 2)", () => {
  const SIGNING = { webhookId: "att_1", timestamp: 1700000000, secrets: [] as never[] };
  // A fake sign dep: returns a fixed (multi-sig) header set; the unseal+sign byte-correctness is proven
  // separately by makeSignDelivery + the PR1 signer KATs. Here we test the header injection + strip wiring.
  function signingDeps(over: Partial<DeliverDeps> = {}) {
    const signMock = vi.fn(async () => ({
      "webhook-id": "msg_signed",
      "webhook-timestamp": "1700000000",
      "webhook-signature": "v1,AAA v1,BBB",
    }));
    const base = deps(over);
    return { ...base, sign: signMock as unknown as DeliverDeps["sign"], signMock };
  }
  const sentHeaders = (d: { fetchMock: ReturnType<typeof vi.fn> }): Headers =>
    (d.fetchMock.mock.calls[0]![1] as { headers: Headers }).headers;

  it("re-signs: strips inbound signature headers + sets ours, signing over the exact payload bytes", async () => {
    const d = signingDeps();
    const args: DeliverArgs = {
      ...ARGS,
      headers: [
        ["Webhook-Id", "inbound_msg"],
        ["Webhook-Signature", "v1,INBOUND"],
        ["Stripe-Signature", "t=1,v1=x"],
        ["Content-Type", "application/json"],
      ],
      signing: SIGNING,
    };
    const r = await guardedDeliver(d, args);
    expect(r.outcome).toBe("delivered");
    // signed over the R2 payload bytes (not a re-encode)
    expect(new TextDecoder().decode(d.signMock.mock.calls[0]![0]!.body)).toBe('{"hello":"world"}');
    const sent = sentHeaders(d);
    expect(sent.get("webhook-id")).toBe("msg_signed");
    expect(sent.get("webhook-timestamp")).toBe("1700000000");
    expect(sent.get("webhook-signature")).toBe("v1,AAA v1,BBB");
    expect(sent.get("stripe-signature")).toBeNull(); // inbound provider signature stripped
    expect(sent.get("content-type")).toBe("application/json"); // non-signature headers preserved
  });

  it("NEVER delivers unsigned when signing was requested but fails — records 'failed', no POST", async () => {
    const d = signingDeps();
    d.signMock.mockRejectedValueOnce(new Error("unseal failed"));
    const r = await guardedDeliver(d, { ...ARGS, signing: SIGNING });
    expect(r.outcome).toBe("failed");
    expect(d.fetchMock).not.toHaveBeenCalled();
  });

  it("delivers verbatim (no sign call) when signing is absent — the 1b behavior is preserved", async () => {
    const d = signingDeps();
    await guardedDeliver(d, ARGS);
    expect(d.signMock).not.toHaveBeenCalled();
    expect(sentHeaders(d).get("webhook-id")).toBe("msg_1"); // inbound header passes through unchanged
  });
});

describe("makeSignDelivery — real unseal + sign round-trips through the verifier", () => {
  it("unseals each sealed secret and emits a webhook-signature the standardWebhooksAdapter accepts", async () => {
    const store = new SecretStore(await LocalKmsProvider.generate());
    const secret = generateSigningSecret();
    const context = { orgId: "o", endpointId: "dest", keyId: "k" };
    const sealed = await store.sealString(secret, context);
    const sign = makeSignDelivery(store);

    const body = new TextEncoder().encode('{"x":1}');
    const ts = Math.floor(new Date("2026-06-30T00:00:00Z").getTime() / 1000);
    const headers = await sign({
      webhookId: "att_1",
      timestamp: ts,
      body,
      secrets: [{ sealed, context }],
    });

    const res = await standardWebhooksAdapter.verify({
      rawBody: body,
      headers: [
        ["webhook-id", headers["webhook-id"]],
        ["webhook-timestamp", headers["webhook-timestamp"]],
        ["webhook-signature", headers["webhook-signature"]],
      ],
      secrets: [secret],
      now: new Date(ts * 1000),
    });
    expect(res).toEqual({ ok: true, keyId: "secret_0", scheme: "standard_webhooks" });
  });
});

describe("resolveViaDoh — Cloudflare DoH JSON", () => {
  const dohFetch = (a: unknown, aaaa: unknown): typeof fetch =>
    (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const type = u.searchParams.get("type");
      return Response.json(type === "AAAA" ? aaaa : a);
    }) as unknown as typeof fetch;

  it("returns every A + AAAA answer address", async () => {
    const f = dohFetch(
      {
        Status: 0,
        Answer: [
          { type: 1, data: "93.184.216.34" },
          { type: 5, data: "cname.example." },
        ],
      },
      { Status: 0, Answer: [{ type: 28, data: "2606:2800:220:1:248:1893:25c8:1946" }] },
    );
    const ips = await resolveViaDoh(f, "example.com");
    expect(ips).toContain("93.184.216.34");
    expect(ips).toContain("2606:2800:220:1:248:1893:25c8:1946");
    expect(ips).not.toContain("cname.example."); // non-address answer types ignored
  });

  it("returns the available family when the other has no record (NXDOMAIN/empty)", async () => {
    const f = dohFetch(
      { Status: 0, Answer: [{ type: 1, data: "1.2.3.4" }] },
      { Status: 3, Answer: [] }, // NXDOMAIN for AAAA
    );
    expect(await resolveViaDoh(f, "v4only.example")).toEqual(["1.2.3.4"]);
  });

  it("fails closed (throws) on a resolver SERVFAIL so the caller blocks", async () => {
    const f = dohFetch({ Status: 2, Answer: [] }, { Status: 0, Answer: [] });
    await expect(resolveViaDoh(f, "broken.example")).rejects.toThrow();
  });
});
