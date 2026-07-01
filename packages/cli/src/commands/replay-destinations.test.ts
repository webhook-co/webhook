import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

const ORG = "22222222-2222-4222-8222-222222222222";
const DEST = "55555555-5555-4555-8555-555555555555";

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

const dest = (over: Record<string, unknown> = {}) => ({
  id: DEST,
  orgId: ORG,
  url: "https://hooks.example.com/in",
  label: "prod",
  status: "active",
  createdAt: "2026-06-30T00:00:00.000Z",
  lastValidatedAt: "2026-06-30T00:00:00.000Z",
  ordered: false,
  disabledAt: null,
  ...over,
});

describe("wbhk replay-destinations add", () => {
  it("registers an https url and prints the canonical record", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(dest()) });
    await run(app, ["replay-destinations", "add", "https://hooks.example.com/in"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("https://hooks.example.com/in");
    expect(t.stdout()).toContain(DEST);
  });

  it("POSTs {url,label} to /v1/replay-destinations", async () => {
    const cap = capturingFetch(dest());
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(
      app,
      ["replay-destinations", "add", "https://hooks.example.com/in", "--label", "prod"],
      t.ctx,
    );
    expect(cap.urls[0]).toContain("/v1/replay-destinations");
    expect(cap.bodies[0]).toContain("https://hooks.example.com/in");
    expect(cap.bodies[0]).toContain("prod");
  });

  it("emits the record as one JSON value with --output json (no stderr noise)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(dest()) });
    await run(
      app,
      ["replay-destinations", "add", "https://hooks.example.com/in", "--output", "json"],
      t.ctx,
    );
    const parsed = JSON.parse(t.stdout()) as { id: string };
    expect(parsed.id).toBe(DEST);
    expect(t.stderr()).toBe("");
  });

  it("maps a server 400 (SSRF-unsafe url) to the VALIDATION_ERROR exit", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(400) });
    await run(app, ["replay-destinations", "add", "https://anything.example.com/in"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.VALIDATION_ERROR);
  });
});

describe("wbhk replay-destinations list", () => {
  it("renders a table of the org's destinations", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch({ items: [dest()] }) });
    await run(app, ["replay-destinations", "list"], t.ctx);
    expect(t.stdout()).toContain("https://hooks.example.com/in");
    expect(t.stdout()).toContain(DEST);
  });

  it("prints a friendly message when the allowlist is empty", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch({ items: [] }) });
    await run(app, ["replay-destinations", "list"], t.ctx);
    expect(t.stdout().toLowerCase()).toContain("no replay destinations");
  });
});

describe("wbhk replay-destinations remove", () => {
  const removed = { id: DEST, deletedAt: "2026-06-30T00:00:00.000Z" };

  it("removes a destination and prints the {id, removed} record (no confirmation gate)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(removed) });
    await run(app, ["replay-destinations", "remove", DEST], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain(DEST);
    expect(t.stdout().toLowerCase()).toContain("removed");
  });

  it("maps a 404 to the NOT_FOUND exit code", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(404) });
    await run(app, ["replay-destinations", "remove", DEST], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.NOT_FOUND);
  });

  it("requires a credential (NotLoggedInError → UNAUTHORIZED exit)", async () => {
    const t = makeTestContext({ store: emptyStore() });
    await run(app, ["replay-destinations", "remove", DEST], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });
});

describe("wbhk replay-destinations enable", () => {
  it("re-enables a destination and prints the record showing it enabled", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch(dest({ disabledAt: null })),
    });
    await run(app, ["replay-destinations", "enable", DEST], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain(DEST);
    expect(t.stdout()).toContain("enabled");
  });

  it("maps a 404 to the NOT_FOUND exit code", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(404) });
    await run(app, ["replay-destinations", "enable", DEST], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.NOT_FOUND);
  });
});

describe("wbhk replay-destinations set-ordered", () => {
  it("sets strict FIFO with the `on` mode and prints the record showing the mode", async () => {
    const cap = capturingFetch(dest({ ordered: true }));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["replay-destinations", "set-ordered", DEST, "on"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(cap.urls[0]).toContain(`/v1/replay-destinations/${DEST}/ordered`);
    expect(JSON.parse(cap.bodies[0]!)).toEqual({ ordered: true }); // the mode rides the JSON body
    expect(t.stdout()).toContain("strict FIFO");
  });

  it("restores best-effort with the `off` mode", async () => {
    const cap = capturingFetch(dest({ ordered: false }));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["replay-destinations", "set-ordered", DEST, "off"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(JSON.parse(cap.bodies[0]!)).toEqual({ ordered: false });
    expect(t.stdout()).toContain("best-effort");
  });

  it("REQUIRES an explicit mode — a bare set-ordered <id> errors, never silently forces best-effort", async () => {
    const cap = capturingFetch(dest());
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["replay-destinations", "set-ordered", DEST], t.ctx);
    // No on/off → a usage error, and crucially NO request is sent (nothing silently toggled).
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(cap.bodies).toHaveLength(0);
  });

  it("rejects an invalid mode (not on/off) as a usage error", async () => {
    const cap = capturingFetch(dest());
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["replay-destinations", "set-ordered", DEST, "maybe"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(cap.bodies).toHaveLength(0);
  });
});
