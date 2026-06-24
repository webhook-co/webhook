import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { StoredCredential } from "../config/schema.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

function memStore(initial: StoredCredential | null = null): CredentialStore {
  let cred = initial;
  let baseUrl: string | undefined;
  return {
    get: async () => cred,
    set: async (c) => void (cred = c),
    erase: async () => void (cred = null),
    list: async () => (cred ? ["default"] : []),
    getApiBaseUrl: async () => baseUrl,
    setApiBaseUrl: async (u) => void (baseUrl = u),
  };
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okFetch = (identity: unknown): typeof fetch =>
  (async () => jsonResponse(identity)) as unknown as typeof fetch;
const statusFetch = (status: number): typeof fetch =>
  (async () => new Response(null, { status })) as unknown as typeof fetch;

describe("wbhk whoami", () => {
  it("errors (not authenticated) when no credential is stored", async () => {
    const t = makeTestContext({ store: memStore(null) });
    await run(app, ["whoami"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
    expect(t.stderr().toLowerCase()).toContain("not logged in");
    expect(t.stdout()).toBe("");
  });

  it("prints the org, scopes, and a redacted key handle for a stored key", async () => {
    const t = makeTestContext({
      store: memStore({ apiKey: "whk_stored_key" }),
      fetch: okFetch({ orgId: "org_9", scopes: ["events:read", "audit:read"] }),
    });
    await run(app, ["whoami"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    const out = t.stdout();
    expect(out).toContain("org: org_9");
    expect(out).toContain("events:read, audit:read");
    expect(out).toContain("whk_****");
    expect(out).not.toContain("whk_stored_key");
    expect(out).toContain("method: api-key");
    expect(out).toContain("source: stored credential");
  });

  it("reports the auth method as oauth (<flow>) for an OAuth credential (text)", async () => {
    const t = makeTestContext({
      store: memStore({
        oauth: {
          accessKey: "whk_oauth_access",
          refreshToken: "rtk_secret_refresh",
          authMethod: "device",
          expiresAt: 4_102_444_800_000, // year 2100 — past expiry would now trigger a proactive refresh
          audience: "https://api.webhook.co",
          clientId: "client_abc",
        },
      }),
      fetch: okFetch({ orgId: "org_o", scopes: ["events:read"] }),
    });
    await run(app, ["whoami"], t.ctx);
    expect(t.stdout()).toContain("method: oauth (device)");
    expect(t.stdout()).toContain("source: stored credential");
  });

  it("works with an OAuth credential: Bearer uses the access key; refresh token NEVER printed", async () => {
    let auth: string | null = null;
    const capturingFetch = (async (_url: string, init?: { headers?: HeadersInit }) => {
      auth = new Headers(init?.headers).get("authorization");
      return jsonResponse({ orgId: "org_o", userId: "usr_o", scopes: ["events:read"] });
    }) as unknown as typeof fetch;
    const t = makeTestContext({
      store: memStore({
        oauth: {
          accessKey: "whk_oauth_access",
          refreshToken: "rtk_secret_refresh",
          authMethod: "loopback",
          expiresAt: 4_102_444_800_000, // year 2100 — past expiry would now trigger a proactive refresh
          audience: "https://api.webhook.co",
          clientId: "client_abc",
        },
      }),
      fetch: capturingFetch,
    });
    await run(app, ["whoami", "--output", "json"], t.ctx);
    expect(auth).toContain("whk_oauth_access"); // the access key is the bearer
    const out = t.stdout();
    expect(out).toContain("org_o");
    expect(out).not.toContain("rtk_"); // the refresh token never reaches output
    expect(out).not.toContain("whk_oauth_access"); // the full access key isn't printed either (redacted)
  });

  it("proactively refreshes an expired OAuth token, uses the new bearer, and persists the rotation", async () => {
    const store = memStore({
      oauth: {
        accessKey: "whk_old_access",
        refreshToken: "rtk_old_refresh",
        authMethod: "loopback",
        expiresAt: 0, // already expired → proactive refresh before the identity call
        audience: "https://api.webhook.co",
        clientId: "client_abc",
      },
    });
    let identityBearer: string | null = null;
    const routingFetch = (async (url: string, init?: { headers?: HeadersInit }) => {
      if (String(url).endsWith("/token")) {
        return jsonResponse({
          access_token: "whk_new_access",
          token_type: "Bearer",
          expires_in: 86400,
          refresh_token: "rtk_new_refresh",
          scope: "events:read",
          resource: "https://api.webhook.co",
        });
      }
      identityBearer = new Headers(init?.headers).get("authorization");
      return jsonResponse({ orgId: "org_o", scopes: ["events:read"] });
    }) as unknown as typeof fetch;
    const t = makeTestContext({ store, fetch: routingFetch });
    await run(app, ["whoami"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("org: org_o");
    expect(identityBearer).toContain("whk_new_access"); // the refreshed token is the bearer
    // The rotated credential was persisted back to the store.
    const persisted = await store.get();
    expect(persisted).toMatchObject({ oauth: { accessKey: "whk_new_access" } });
  });

  it("sanitizes control bytes in the server-supplied org/userId/scopes (text view)", async () => {
    // orgId/userId/scopes are server-controlled (z.string()); a hostile value must not inject a
    // terminal escape into the text view. (JSON mode is already safe — JSON.stringify escapes them.)
    const ESC = String.fromCharCode(27);
    const t = makeTestContext({
      store: memStore({ apiKey: "whk_stored_key" }),
      fetch: okFetch({
        orgId: `org_9${ESC}[31m`,
        userId: `usr_7${ESC}[2K`,
        scopes: [`events:read${ESC}[0m`],
      }),
    });
    await run(app, ["whoami"], t.ctx);
    expect(t.stdout()).not.toContain(ESC);
    expect(t.stdout()).toContain("org_9"); // the visible text survives, only the control bytes go
  });

  it("surfaces a server 401 (revoked/expired key) as an auth error", async () => {
    const t = makeTestContext({
      store: memStore({ apiKey: "whk_revoked" }),
      fetch: statusFetch(401),
    });
    await run(app, ["whoami"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
    expect(t.stderr().toLowerCase()).toContain("authentication failed");
  });

  it("resolves identity from WBHK_API_KEY via the real store (no file, no disk)", async () => {
    // No store override → the real env+file store; the env backend resolves the key (file untouched).
    const t = makeTestContext({
      env: { WBHK_API_KEY: "whk_env_key" },
      fetch: okFetch({ orgId: "org_e", scopes: [] }),
    });
    await run(app, ["whoami"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("org: org_e");
    expect(t.stdout()).toContain("scopes: (none)");
    // The env backend has highest read precedence, so the source is reported as the env var.
    expect(t.stdout()).toContain("method: api-key");
    expect(t.stdout()).toContain("source: env (WBHK_API_KEY)");
  });

  it("reports source: keychain when the credential lives in the OS keychain", async () => {
    // No store override → the real [env, keychain, file] store; a working keychain fake holds the cred,
    // so getWithSource reports the actual backend (not the generic "stored credential").
    const m = new Map<string, string>();
    const keychain = {
      get: async (a: string) => m.get(a) ?? null,
      set: async (a: string, s: string) => void m.set(a, s),
      erase: async (a: string) => void m.delete(a),
    };
    await keychain.set("default", JSON.stringify({ apiKey: "whk_kc" }));
    const t = makeTestContext({
      keychain,
      fetch: okFetch({ orgId: "org_k", scopes: ["events:read"] }),
    });
    await run(app, ["whoami"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("source: keychain");
  });

  it("surfaces a userId when the principal has one (user-scoped token)", async () => {
    const t = makeTestContext({
      store: memStore({ apiKey: "whk_user_token" }),
      fetch: okFetch({ orgId: "org_u", userId: "usr_7", scopes: ["events:read"] }),
    });
    await run(app, ["whoami"], t.ctx);
    expect(t.stdout()).toContain("user: usr_7");
    const j = makeTestContext({
      store: memStore({ apiKey: "whk_user_token" }),
      fetch: okFetch({ orgId: "org_u", userId: "usr_7", scopes: ["events:read"] }),
    });
    await run(app, ["whoami", "--output", "json"], j.ctx);
    expect(JSON.parse(j.stdout())).toMatchObject({ orgId: "org_u", userId: "usr_7" });
  });

  it("emits JSON with --output json", async () => {
    const t = makeTestContext({
      store: memStore({ apiKey: "whk_stored_key" }),
      fetch: okFetch({ orgId: "org_9", scopes: ["events:read"] }),
    });
    await run(app, ["whoami", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toEqual({
      orgId: "org_9",
      scopes: ["events:read"],
      key: "whk_****",
      method: "api-key",
      source: "stored credential",
    });
  });

  it("emits the OAuth method in JSON without leaking the refresh token", async () => {
    const t = makeTestContext({
      store: memStore({
        oauth: {
          accessKey: "whk_oauth_access",
          refreshToken: "rtk_secret_refresh",
          authMethod: "loopback",
          expiresAt: 4_102_444_800_000, // year 2100 — past expiry would now trigger a proactive refresh
          audience: "https://api.webhook.co",
          clientId: "client_abc",
        },
      }),
      fetch: okFetch({ orgId: "org_o", scopes: ["events:read"] }),
    });
    await run(app, ["whoami", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout());
    expect(parsed).toMatchObject({ method: "oauth (loopback)", source: "stored credential" });
    expect(t.stdout()).not.toContain("rtk_");
  });
});
