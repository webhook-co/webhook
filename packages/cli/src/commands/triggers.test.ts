import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "33333333-3333-4333-8333-333333333333";
const TRIGGER = "44444444-4444-4444-8444-444444444444";

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
function emptyStore(): CredentialStore {
  return {
    get: async () => null,
    set: async () => undefined,
    erase: async () => undefined,
    list: async () => [],
    getApiBaseUrl: async () => undefined,
    setApiBaseUrl: async () => undefined,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okFetch = (body: unknown): typeof fetch =>
  (async () => json(body)) as unknown as typeof fetch;
const statusFetch = (status: number): typeof fetch =>
  (async () => new Response(null, { status })) as unknown as typeof fetch;
function capturingFetch(body: unknown): { fetch: typeof fetch; urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return json(body);
  }) as unknown as typeof fetch;
  return { fetch, urls, bodies };
}

const trigger = (over: Record<string, unknown> = {}) => ({
  id: TRIGGER,
  orgId: ORG,
  endpointId: ENDPOINT,
  name: null,
  createdAt: "2026-07-07T00:00:00.000Z",
  revokedAt: null,
  ...over,
});

describe("wbhk triggers add", () => {
  it("registers a trigger for an endpoint and prints the record", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(trigger()) });
    await run(app, ["triggers", "add", ENDPOINT], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain(TRIGGER);
    expect(t.stdout()).toContain(ENDPOINT);
  });

  it("POSTs {endpointId,name} to /v1/triggers", async () => {
    const cap = capturingFetch(trigger({ name: "fraud-agent" }));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["triggers", "add", ENDPOINT, "--name", "fraud-agent"], t.ctx);
    expect(cap.urls[0]).toContain("/v1/triggers");
    expect(cap.bodies[0]).toContain(ENDPOINT);
    expect(cap.bodies[0]).toContain("fraud-agent");
  });

  it("emits the record as one JSON value with --output json (no stderr noise)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(trigger()) });
    await run(app, ["triggers", "add", ENDPOINT, "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout()) as { id: string };
    expect(parsed.id).toBe(TRIGGER);
    expect(t.stderr()).toBe("");
  });

  it("maps a server 404 (unknown endpoint) to the NOT_FOUND exit", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(404) });
    await run(app, ["triggers", "add", ENDPOINT], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.NOT_FOUND);
  });

  it("requires a credential (NotLoggedInError → UNAUTHORIZED exit)", async () => {
    const t = makeTestContext({ store: emptyStore() });
    await run(app, ["triggers", "add", ENDPOINT], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });
});

describe("wbhk triggers list", () => {
  it("renders a table of the org's active triggers", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [trigger({ name: "ops-agent" })] }),
    });
    await run(app, ["triggers", "list"], t.ctx);
    expect(t.stdout()).toContain(TRIGGER);
    expect(t.stdout()).toContain("ops-agent");
  });

  it("prints a friendly message when there are no triggers", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch({ items: [] }) });
    await run(app, ["triggers", "list"], t.ctx);
    expect(t.stdout().toLowerCase()).toContain("no triggers");
  });

  it("passes the --endpoint filter as a query param", async () => {
    const cap = capturingFetch({ items: [] });
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["triggers", "list", "--endpoint", ENDPOINT], t.ctx);
    expect(cap.urls[0]).toContain(`endpointId=${ENDPOINT}`);
  });

  it("emits { items } as JSON with --output json", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [trigger()] }),
    });
    await run(app, ["triggers", "list", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout()) as { items: { id: string }[] };
    expect(parsed.items[0]?.id).toBe(TRIGGER);
    expect(t.stderr()).toBe("");
  });
});

describe("wbhk triggers revoke", () => {
  it("revokes a trigger and prints the {id, revoked} record", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch({ id: TRIGGER }) });
    await run(app, ["triggers", "revoke", TRIGGER], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain(TRIGGER);
    expect(t.stdout().toLowerCase()).toContain("revoked");
  });

  it("maps a 404 to the NOT_FOUND exit code", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(404) });
    await run(app, ["triggers", "revoke", TRIGGER], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.NOT_FOUND);
  });

  it("requires a credential (NotLoggedInError → UNAUTHORIZED exit)", async () => {
    const t = makeTestContext({ store: emptyStore() });
    await run(app, ["triggers", "revoke", TRIGGER], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });
});

const triggerEvent = (over: Record<string, unknown> = {}) => ({
  id: "01920000-0000-7000-8000-000000000001",
  orgId: ORG,
  endpointId: ENDPOINT,
  receivedAt: "2026-07-07T00:00:00.000Z",
  provider: "stripe",
  dedupKey: "dk",
  dedupStrategy: "content_hash",
  verified: true,
  verificationState: "verified",
  vouched: true,
  ...over,
});

describe("wbhk triggers wait", () => {
  it("prints the events table + cursor footer for a trigger", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ events: [triggerEvent()], nextCursor: "cur_next", caughtUp: true }),
    });
    await run(app, ["triggers", "wait", TRIGGER], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("stripe");
    expect(t.stdout()).toContain("cur_next");
  });

  it("passes --cursor and --limit as query params", async () => {
    const cap = capturingFetch({ events: [], nextCursor: null, caughtUp: true });
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["triggers", "wait", TRIGGER, "--cursor", "cur0", "--limit", "10"], t.ctx);
    expect(cap.urls[0]).toContain(`/v1/triggers/${TRIGGER}/wait`);
    expect(cap.urls[0]).toContain("cursor=cur0");
    expect(cap.urls[0]).toContain("limit=10");
  });

  it("emits the result as JSON with --output json (no stderr)", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ events: [triggerEvent()], nextCursor: "cur_next", caughtUp: false }),
    });
    await run(app, ["triggers", "wait", TRIGGER, "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout()) as { nextCursor: string; caughtUp: boolean };
    expect(parsed.nextCursor).toBe("cur_next");
    expect(parsed.caughtUp).toBe(false);
    expect(t.stderr()).toBe("");
  });

  it("prints a friendly message when caught up with no events", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ events: [], nextCursor: null, caughtUp: true }),
    });
    await run(app, ["triggers", "wait", TRIGGER], t.ctx);
    expect(t.stdout().toLowerCase()).toContain("no new events");
  });

  it("maps a 404 (unknown/revoked trigger) to the NOT_FOUND exit", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(404) });
    await run(app, ["triggers", "wait", TRIGGER], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.NOT_FOUND);
  });
});
