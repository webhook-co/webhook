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

  it("prompts interactively with --api-key and persists the entered key", async () => {
    const mem = memStore();
    const t = makeTestContext({
      store: mem.store,
      promptResponse: "whk_prompted",
      fetch: okFetch({ orgId: "org_3", scopes: ["audit:read"] }),
    });
    await run(app, ["login", "--api-key"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(mem.current()).toEqual({ apiKey: "whk_prompted" });
  });

  it("--api-key on a non-interactive terminal errors (no prompt possible)", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store }); // not a TTY
    await run(app, ["login", "--api-key"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("--api-key needs an interactive terminal");
    expect(mem.current()).toBeNull();
  });

  it("fails fast (does not hang) when --stdin is given on an interactive terminal", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store, isInteractive: true }); // a TTY, nothing piped
    await run(app, ["login", "--stdin"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("stdin is a terminal");
    expect(mem.current()).toBeNull();
  });

  it("errors (usage) on a headless run with no credential source (can't open a browser)", async () => {
    const mem = memStore();
    const t = makeTestContext({ store: mem.store }); // not a TTY, no flags, no WBHK_API_KEY
    await run(app, ["login"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("no credential source for a headless run");
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

const DEVICE_AUTH = {
  device_code: "dev_code_1",
  user_code: "WXYZ-1234",
  verification_uri: "https://auth.webhook.co/device",
  verification_uri_complete: "https://auth.webhook.co/device?user_code=WXYZ-1234",
  expires_in: 900,
  interval: 5,
};
const TOKEN_BODY = {
  access_token: `whk_${"d".repeat(40)}`,
  token_type: "Bearer",
  expires_in: 86400,
  refresh_token: `rtk_${"e".repeat(40)}`,
  scope: "events:read",
  resource: "https://api.webhook.co",
};

/** Routes a fetch by URL through the full device-login round-trip: register → device-authorize → poll
 *  (the `pollSteps` sequence) → whoami. */
function deviceRoutingFetch(pollSteps: ReadonlyArray<Response>): typeof fetch {
  let pollIdx = 0;
  return (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/register")) return jsonResponse({ client_id: "client_dcr_1" });
    if (u.endsWith("/device_authorization")) return jsonResponse(DEVICE_AUTH);
    if (u.endsWith("/token")) {
      const step = pollSteps[Math.min(pollIdx, pollSteps.length - 1)];
      pollIdx += 1;
      return step;
    }
    if (u.endsWith("/v1/whoami")) return jsonResponse(IDENTITY);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

describe("wbhk login --device", () => {
  it("runs the device flow, persists the OAuth credential, and opens the browser", async () => {
    const m = memStore();
    let opened: string | null = null;
    const t = makeTestContext({
      store: m.store,
      fetch: deviceRoutingFetch([jsonResponse(TOKEN_BODY)]),
      openBrowser: async (u) => void (opened = u),
    });
    await run(app, ["login", "--device"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    // An OAuth credential was stored (not an api-key shape).
    expect(m.current()).toMatchObject({
      oauth: { authMethod: "device", clientId: "client_dcr_1" },
    });
    // The user-facing code + URL went to stderr; the browser was opened to the complete URL.
    expect(t.stderr()).toContain("WXYZ-1234");
    expect(opened).toBe("https://auth.webhook.co/device?user_code=WXYZ-1234");
    expect(t.stdout()).toContain("logged in to org_1 via device");
    // Neither the access nor the refresh token is printed in full.
    expect(t.stdout()).not.toContain(TOKEN_BODY.refresh_token);
    expect(t.stdout()).not.toContain(TOKEN_BODY.access_token);
  });

  it("emits JSON with method oauth (device) and never leaks the refresh token", async () => {
    const m = memStore();
    const t = makeTestContext({
      store: m.store,
      fetch: deviceRoutingFetch([jsonResponse(TOKEN_BODY)]),
    });
    await run(app, ["login", "--device", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout());
    expect(parsed).toMatchObject({ orgId: "org_1", persisted: true, method: "oauth (device)" });
    expect(t.stdout()).not.toContain("rtk_");
  });

  it("polls through authorization_pending until approval", async () => {
    const m = memStore();
    const t = makeTestContext({
      store: m.store,
      fetch: deviceRoutingFetch([
        jsonResponse({ error: "authorization_pending" }, 400),
        jsonResponse(TOKEN_BODY),
      ]),
    });
    await run(app, ["login", "--device"], t.ctx);
    expect(m.current()).toMatchObject({ oauth: { authMethod: "device" } });
  });

  it("stores NOTHING when the user denies the device authorization", async () => {
    const m = memStore();
    const t = makeTestContext({
      store: m.store,
      fetch: deviceRoutingFetch([jsonResponse({ error: "access_denied" }, 400)]),
    });
    await run(app, ["login", "--device"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
    expect(m.current()).toBeNull();
  });

  it("passes --insecure-storage through on the device path", async () => {
    const m = memStore();
    const t = makeTestContext({
      store: m.store,
      fetch: deviceRoutingFetch([jsonResponse(TOKEN_BODY)]),
    });
    await run(app, ["login", "--device", "--insecure-storage"], t.ctx);
    expect(m.lastSetOpts()?.allowInsecure).toBe(true);
  });
});

/** Routes the loopback round-trip: register → token → whoami. */
function loopbackRoutingFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.endsWith("/register")) return jsonResponse({ client_id: "client_loop_1" });
    if (u.endsWith("/token")) return jsonResponse(TOKEN_BODY);
    if (u.endsWith("/v1/whoami")) return jsonResponse(IDENTITY);
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

/** A fake loopback server + browser that mirror the real flow: the recorded authorize URL's `state` is
 *  echoed back on the callback (the success path). */
function loopbackHarness() {
  let authorizeUrl = "";
  return {
    openBrowser: async (u: string) => void (authorizeUrl = u),
    startLoopbackServer: async () => ({
      port: 51900,
      waitForCallback: async () => {
        const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
        return new URLSearchParams({ code: "loop_code_1", state });
      },
      close: () => {},
    }),
    authorizeUrl: () => authorizeUrl,
  };
}

describe("wbhk login (default: loopback browser OAuth)", () => {
  it("runs the loopback flow on a plain interactive `login`, opens the browser, and persists the OAuth credential", async () => {
    const m = memStore();
    const h = loopbackHarness();
    const t = makeTestContext({
      store: m.store,
      isInteractive: true,
      fetch: loopbackRoutingFetch(),
      openBrowser: h.openBrowser,
      startLoopbackServer: h.startLoopbackServer,
    });
    await run(app, ["login"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(m.current()).toMatchObject({
      oauth: { authMethod: "loopback", clientId: "client_loop_1" },
    });
    // The browser was opened to the issuer's /authorize with a loopback redirect.
    const opened = new URL(h.authorizeUrl());
    expect(opened.origin + opened.pathname).toBe("https://auth.webhook.co/authorize");
    expect(opened.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(t.stdout()).toContain("logged in to org_1 via browser");
    expect(t.stdout()).not.toContain(TOKEN_BODY.refresh_token);
    expect(t.stdout()).not.toContain(TOKEN_BODY.access_token);
  });

  it("emits JSON with method oauth (loopback) and never leaks the refresh token", async () => {
    const m = memStore();
    const h = loopbackHarness();
    const t = makeTestContext({
      store: m.store,
      isInteractive: true,
      fetch: loopbackRoutingFetch(),
      openBrowser: h.openBrowser,
      startLoopbackServer: h.startLoopbackServer,
    });
    await run(app, ["login", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout());
    expect(parsed).toMatchObject({ orgId: "org_1", persisted: true, method: "oauth (loopback)" });
    expect(t.stdout()).not.toContain("rtk_");
  });

  it("passes --insecure-storage through on the loopback path", async () => {
    const m = memStore();
    const h = loopbackHarness();
    const t = makeTestContext({
      store: m.store,
      isInteractive: true,
      fetch: loopbackRoutingFetch(),
      openBrowser: h.openBrowser,
      startLoopbackServer: h.startLoopbackServer,
    });
    await run(app, ["login", "--insecure-storage"], t.ctx);
    expect(m.lastSetOpts()?.allowInsecure).toBe(true);
  });
});
