import { describe, expect, it } from "vitest";

import type { LoopbackServer } from "../context.js";
import { OAuthError } from "../errors.js";
import { loopbackLogin } from "./loopback-login.js";

const AUTH_BASE = "https://auth.webhook.co";
const FROZEN = {
  access_token: "whk_access",
  token_type: "Bearer",
  expires_in: 86400,
  refresh_token: "rtk_refresh",
  scope: "events:read",
  resource: "https://api.webhook.co",
};
const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Routes /register → {client_id} and /token → FROZEN, recording the /token form body. */
function routingFetch(): {
  fetch: typeof fetch;
  tokenBody: () => URLSearchParams;
  calls: () => string[];
} {
  const calls: string[] = [];
  let tokenBody = new URLSearchParams();
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/register")) return jsonRes({ client_id: "client_loop_1" });
    if (u.endsWith("/token")) {
      tokenBody = new URLSearchParams(String(init?.body));
      return jsonRes(FROZEN);
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetch, tokenBody: () => tokenBody, calls: () => calls };
}

/**
 * A fake loopback server that mirrors the real flow: `openBrowser` records the authorize URL, and
 * `waitForCallback` returns the callback query — by default echoing the `state` the orchestration put in
 * that URL (the success path), with the given code/error overrides.
 */
function harness(over: { state?: string; code?: string | null; error?: string } = {}) {
  let authorizeUrl = "";
  let closed = false;
  const server: LoopbackServer = {
    port: 51789,
    waitForCallback: async () => {
      const echoedState = over.state ?? new URL(authorizeUrl).searchParams.get("state") ?? "";
      const params = new URLSearchParams();
      if (over.error) {
        params.set("error", over.error);
      } else if (over.code !== null) {
        params.set("code", over.code ?? "auth_code_xyz");
      }
      params.set("state", echoedState);
      return params;
    },
    close: () => {
      closed = true;
    },
  };
  return {
    startLoopbackServer: async () => server,
    openBrowser: async (u: string) => {
      authorizeUrl = u;
    },
    authorizeUrl: () => authorizeUrl,
    closed: () => closed,
  };
}

const deps = (h: ReturnType<typeof harness>, fetch: typeof fetch) => ({
  fetch,
  authBaseUrl: AUTH_BASE,
  scope: "events:read events:replay",
  resource: "https://api.webhook.co",
  startLoopbackServer: h.startLoopbackServer,
  openBrowser: h.openBrowser,
  emit: () => {},
});

describe("loopbackLogin", () => {
  it("runs the full loopback PKCE flow and returns the token body + clientId", async () => {
    const h = harness();
    const f = routingFetch();
    const result = await loopbackLogin(deps(h, f.fetch));
    expect(result).toEqual({ body: FROZEN, clientId: "client_loop_1" });
    expect(h.closed()).toBe(true); // the server is always torn down
  });

  it("builds an authorize URL with response_type=code, S256 PKCE, state, scope, resource, and the loopback redirect", async () => {
    const h = harness();
    const f = routingFetch();
    await loopbackLogin(deps(h, f.fetch));
    const u = new URL(h.authorizeUrl());
    expect(u.origin + u.pathname).toBe("https://auth.webhook.co/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("client_loop_1");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("scope")).toBe("events:read events:replay");
    expect(u.searchParams.get("resource")).toBe("https://api.webhook.co");
    // The redirect URI is the loopback IP literal with the server's ephemeral port.
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:51789/callback");
  });

  it("registers a client for the exact loopback redirect URI (per-login)", async () => {
    const h = harness();
    const f = routingFetch();
    await loopbackLogin(deps(h, f.fetch));
    expect(f.calls().some((u) => u.endsWith("/register"))).toBe(true);
  });

  it("exchanges the captured code with the PKCE verifier + the same redirect URI", async () => {
    const h = harness({ code: "the_real_code" });
    const f = routingFetch();
    await loopbackLogin(deps(h, f.fetch));
    const body = f.tokenBody();
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the_real_code");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:51789/callback");
    expect(body.get("client_id")).toBe("client_loop_1");
  });

  it("rejects a state mismatch (CSRF) and still closes the server", async () => {
    const h = harness({ state: "not-the-real-state" });
    const f = routingFetch();
    await expect(loopbackLogin(deps(h, f.fetch))).rejects.toBeInstanceOf(OAuthError);
    expect(h.closed()).toBe(true);
    expect(f.calls().some((u) => u.endsWith("/token"))).toBe(false); // never exchanged
  });

  it("surfaces an error param from the redirect (e.g. user denied) as an OAuthError", async () => {
    const h = harness({ error: "access_denied" });
    const f = routingFetch();
    await expect(loopbackLogin(deps(h, f.fetch))).rejects.toMatchObject({ code: "access_denied" });
    expect(h.closed()).toBe(true);
  });

  it("rejects when the redirect carries no code", async () => {
    const h = harness({ code: null });
    const f = routingFetch();
    await expect(loopbackLogin(deps(h, f.fetch))).rejects.toBeInstanceOf(OAuthError);
  });

  it("works with no openBrowser at all (the URL is only emitted)", async () => {
    const f = routingFetch();
    let emitted = "";
    const server: LoopbackServer = {
      port: 51789,
      waitForCallback: async () => {
        const match = emitted.match(/https?:\/\/\S+/);
        const state = match ? (new URL(match[0]).searchParams.get("state") ?? "") : "";
        return new URLSearchParams({ code: "c", state });
      },
      close: () => {},
    };
    const result = await loopbackLogin({
      fetch: f.fetch,
      authBaseUrl: AUTH_BASE,
      scope: "events:read",
      resource: "https://api.webhook.co",
      startLoopbackServer: async () => server,
      emit: (line) => void (emitted += line),
      // openBrowser intentionally omitted
    });
    expect(result.clientId).toBe("client_loop_1");
  });

  it("does not fail if opening the browser throws (the URL is also printed)", async () => {
    const h = harness();
    const f = routingFetch();
    const result = await loopbackLogin({
      ...deps(h, f.fetch),
      // Record the URL (the user would still see it printed) then fail — the flow must continue.
      openBrowser: async (u: string) => {
        await h.openBrowser(u);
        throw new Error("no browser");
      },
    });
    expect(result.clientId).toBe("client_loop_1");
  });
});
