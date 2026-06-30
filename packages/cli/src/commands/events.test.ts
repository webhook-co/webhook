import { run } from "@stricli/core";
import { bytesToB64 } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const EP = "11111111-1111-4111-8111-111111111111";
const EV = "33333333-3333-4333-8333-333333333333";

function loggedInStore(): CredentialStore {
  let baseUrl: string | undefined;
  return {
    get: async () => ({ apiKey: "whk_test" }),
    set: async () => undefined,
    erase: async () => undefined,
    list: async () => ["default"],
    getApiBaseUrl: async () => baseUrl,
    setApiBaseUrl: async (u) => void (baseUrl = u),
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okFetch = (body: unknown): typeof fetch =>
  (async () => json(body)) as unknown as typeof fetch;
function capturingFetch(body: unknown): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return json(body);
  }) as unknown as typeof fetch;
  return { fetch, urls };
}

const summary = (over: Record<string, unknown> = {}) => ({
  id: EV,
  orgId: ORG,
  endpointId: EP,
  receivedAt: "2026-05-02T14:23:07.000Z",
  provider: null,
  dedupKey: "dk_1",
  dedupStrategy: "sw_webhook_id",
  verified: false,
  ...over,
});

const fullEvent = {
  ...summary({ provider: "stripe", verified: true }),
  payloadR2Key: "r2/k",
  payloadBytes: 321,
  contentType: "application/json",
  method: "POST",
  headers: [["content-type", "application/json"]],
  providerEventId: null,
  externalId: null,
  verification: { ok: true, keyId: "key_1", scheme: "stripe" },
};

describe("wbhk events list", () => {
  it("renders a table with an em dash for a null provider and the verified word", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [summary()], nextCursor: null }),
    });
    await run(app, ["events", "list", EP], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("PROVIDER");
    expect(t.stdout()).toContain("—");
    expect(t.stdout()).toContain("unverified");
  });

  it("passes the --provider filter through to the request", async () => {
    const cap = capturingFetch({ items: [], nextCursor: null });
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["events", "list", EP, "--provider", "stripe"], t.ctx);
    const u = new URL(cap.urls[0]);
    expect(u.pathname).toBe(`/v1/endpoints/${EP}/events`);
    expect(u.searchParams.get("provider")).toBe("stripe");
  });

  it("rejects an unknown --provider as a usage error", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["events", "list", EP, "--provider", "bogus"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
  });

  it("passes a --after/--before range through as normalized ISO query params", async () => {
    const cap = capturingFetch({ items: [], nextCursor: null });
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(
      app,
      ["events", "list", EP, "--after", "2026-06-01T00:00:00Z", "--before", "2026-06-02"],
      t.ctx,
    );
    const u = new URL(cap.urls[0]);
    expect(u.searchParams.get("receivedAfter")).toBe("2026-06-01T00:00:00.000Z");
    expect(u.searchParams.get("receivedBefore")).toBe("2026-06-02T00:00:00.000Z");
  });

  it("rejects an unparseable --after as a usage error", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["events", "list", EP, "--after", "not-a-date"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
  });

  it("passes --status through as the verificationState query param", async () => {
    const cap = capturingFetch({ items: [], nextCursor: null });
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["events", "list", EP, "--status", "failed"], t.ctx);
    const u = new URL(cap.urls[0]);
    expect(u.searchParams.get("verificationState")).toBe("failed");
  });

  it("rejects an unknown --status as a usage error (closed enum)", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["events", "list", EP, "--status", "bogus"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
  });

  it("passes --search through as the search query param", async () => {
    const cap = capturingFetch({ items: [], nextCursor: null });
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["events", "list", EP, "--search", "evt_123"], t.ctx);
    const u = new URL(cap.urls[0]);
    expect(u.searchParams.get("search")).toBe("evt_123");
  });

  it("emits the envelope with --output json", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [summary()], nextCursor: "ev_next" }),
    });
    await run(app, ["events", "list", EP, "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout());
    expect(parsed.nextCursor).toBe("ev_next");
    expect(parsed.items[0].id).toBe(EV);
  });
});

describe("wbhk events get", () => {
  it("renders a full event with the verification scheme on success", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(fullEvent) });
    await run(app, ["events", "get", EV], t.ctx);
    expect(t.stdout()).toContain("verified (stripe)");
    expect(t.stdout()).toContain("321 bytes");
  });

  it("requires a credential", async () => {
    const t = makeTestContext({
      store: {
        get: async () => null,
        set: async () => undefined,
        erase: async () => undefined,
        list: async () => [],
        getApiBaseUrl: async () => undefined,
        setApiBaseUrl: async () => undefined,
      },
    });
    await run(app, ["events", "get", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });
});

describe("wbhk events payload", () => {
  const envelope = (body: Uint8Array, contentType: string | null = "application/json") => ({
    contentType,
    bytes: body.byteLength,
    bodyBase64: bytesToB64(body),
  });

  it("writes the raw body verbatim in text mode (no added newline)", async () => {
    const body = new TextEncoder().encode('{"order":42}');
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(envelope(body)) });
    await run(app, ["events", "payload", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toBe('{"order":42}');
  });

  it("emits the lossless base64 envelope with --output json", async () => {
    const body = Uint8Array.from([0x00, 0x01, 0x02, 0xfe, 0xff]);
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(envelope(body, null)) });
    await run(app, ["events", "payload", EV, "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout());
    expect(parsed.contentType).toBeNull();
    expect(parsed.bodyBase64).toBe(bytesToB64(body));
  });

  it("targets the /payload path", async () => {
    const cap = capturingFetch(envelope(new TextEncoder().encode("x")));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["events", "payload", EV], t.ctx);
    expect(new URL(cap.urls[0]).pathname).toBe(`/v1/events/${EV}/payload`);
  });
});
