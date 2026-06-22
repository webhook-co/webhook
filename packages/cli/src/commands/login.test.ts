import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { StoredCredential } from "../config/schema.js";
import type { CredentialStore, SetCredentialOptions } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

// In-memory credential store so command tests assert get/set without touching disk.
function memStore(initial: StoredCredential | null = null): {
  store: CredentialStore;
  current: () => StoredCredential | null;
  baseUrl: () => string | undefined;
  lastSetOpts: () => SetCredentialOptions | undefined;
} {
  let cred = initial;
  let baseUrl: string | undefined;
  let lastSetOpts: SetCredentialOptions | undefined;
  return {
    store: {
      get: async () => cred,
      set: async (c, _profile, opts) => void ((cred = c), (lastSetOpts = opts)),
      erase: async () => void (cred = null),
      list: async () => (cred ? ["default"] : []),
      getApiBaseUrl: async () => baseUrl,
      setApiBaseUrl: async (u) => void (baseUrl = u),
    },
    current: () => cred,
    baseUrl: () => baseUrl,
    lastSetOpts: () => lastSetOpts,
  };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okFetch = (identity: unknown): typeof fetch =>
  (async () => jsonResponse(identity)) as unknown as typeof fetch;
const statusFetch = (status: number): typeof fetch =>
  (async () => new Response(null, { status })) as unknown as typeof fetch;

const IDENTITY = { orgId: "org_1", scopes: ["events:read"] };
// Built from a repeat (not a long literal) so it's realistically long for the redaction assertion
// without tripping secret scanners on a token-shaped string. The "whk_" prefix is all redaction keeps.
const LONG_FAKE_KEY = `whk_${"x".repeat(40)}`;

describe("wbhk login", () => {
  it("validates a key piped on --stdin and persists it", async () => {
    const mem = memStore();
    const key = LONG_FAKE_KEY;
    const t = makeTestContext({ store: mem.store, stdin: key, fetch: okFetch(IDENTITY) });
    await run(app, ["login", "--stdin"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(mem.current()).toEqual({ apiKey: key });
    expect(t.stdout()).toContain("logged in to org_1");
    expect(t.stdout()).toContain("whk_****"); // redacted, never the full key
    expect(t.stdout()).not.toContain(key);
  });

  it("rejects a bad key and stores NOTHING", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store, stdin: "whk_bad", fetch: statusFetch(401) });
    await run(app, ["login", "--stdin"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
    expect(mem.current()).toBeNull();
    expect(t.stderr().toLowerCase()).toContain("authentication failed");
  });

  it("validates WBHK_API_KEY but does NOT persist it (the headless path)", async () => {
    const mem = memStore();
    const t = makeTestContext({
      store: mem.store,
      env: { WBHK_API_KEY: "whk_env" },
      fetch: okFetch({ orgId: "org_2", scopes: [] }),
    });
    await run(app, ["login"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(mem.current()).toBeNull();
    expect(t.stdout()).toContain("not persisted");
  });

  it("prompts interactively when no --stdin/env is given, and persists the entered key", async () => {
    const mem = memStore();
    const t = makeTestContext({
      store: mem.store,
      promptResponse: "whk_prompted",
      fetch: okFetch({ orgId: "org_3", scopes: ["audit:read"] }),
    });
    await run(app, ["login"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(mem.current()).toEqual({ apiKey: "whk_prompted" });
  });

  it("fails fast (does not hang) when --stdin is given on an interactive terminal", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store, isInteractive: true }); // a TTY, nothing piped
    await run(app, ["login", "--stdin"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("stdin is a terminal");
    expect(mem.current()).toBeNull();
  });

  it("errors with a usage code when no key source is available and stdin is not a TTY", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store });
    await run(app, ["login"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("no api key provided");
    expect(mem.current()).toBeNull();
  });

  it("targets the API base URL from --api-url", async () => {
    const mem = memStore();
    const calls: string[] = [];
    const capturingFetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return jsonResponse(IDENTITY);
    }) as unknown as typeof fetch;
    const t = makeTestContext({ store: mem.store, stdin: "whk_x", fetch: capturingFetch });
    await run(app, ["login", "--stdin", "--api-url", "https://api.dev.example"], t.ctx);
    expect(calls[0]).toBe("https://api.dev.example/v1/whoami");
  });

  it("persists --api-url as the sticky base URL on a stdin login", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store, stdin: "whk_x", fetch: okFetch(IDENTITY) });
    await run(app, ["login", "--stdin", "--api-url", "https://api.dev.example/"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    // The NORMALIZED origin is stored (trailing slash stripped), not the raw flag.
    expect(mem.baseUrl()).toBe("https://api.dev.example");
  });

  it("does NOT persist a base URL on a plain stdin login (no --api-url to make sticky)", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store, stdin: "whk_x", fetch: okFetch(IDENTITY) });
    await run(app, ["login", "--stdin"], t.ctx);
    expect(mem.baseUrl()).toBeUndefined();
  });

  it("persists NOTHING (key or base URL) on the WBHK_API_KEY env path", async () => {
    const mem = memStore();
    const t = makeTestContext({
      store: mem.store,
      env: { WBHK_API_KEY: "whk_env", WBHK_API_URL: "https://api.dev.example" },
      fetch: okFetch(IDENTITY),
    });
    await run(app, ["login"], t.ctx);
    expect(mem.current()).toBeNull();
    expect(mem.baseUrl()).toBeUndefined();
  });

  it("emits JSON (with the redacted key + persisted flag) with --output json", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store, stdin: LONG_FAKE_KEY, fetch: okFetch(IDENTITY) });
    await run(app, ["login", "--stdin", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toMatchObject({
      orgId: "org_1",
      key: "whk_****",
      persisted: true,
    });
  });
});

describe("wbhk login --insecure-storage", () => {
  it("passes --insecure-storage through to the store as allowInsecure", async () => {
    const m = memStore();
    const t = makeTestContext({ store: m.store, stdin: "whk_via_stdin", fetch: okFetch(IDENTITY) });
    await run(app, ["login", "--stdin", "--insecure-storage"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(m.lastSetOpts()?.allowInsecure).toBe(true);
  });

  it("defaults to secure storage (allowInsecure falsy) without the flag", async () => {
    const m = memStore();
    const t = makeTestContext({ store: m.store, stdin: "whk_via_stdin", fetch: okFetch(IDENTITY) });
    await run(app, ["login", "--stdin"], t.ctx);
    expect(m.lastSetOpts()?.allowInsecure).toBeFalsy();
  });
});
