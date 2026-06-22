import { describe, expect, it } from "vitest";

import type { OAuthCredential, StoredCredential } from "../config/schema.js";
import { createTokenManager, REFRESH_SKEW_MS } from "./token-manager.js";

const AUTH_BASE = "https://auth.webhook.co";

const oauthCred = (over: Partial<OAuthCredential["oauth"]> = {}): OAuthCredential => ({
  oauth: {
    accessKey: "whk_old_access",
    refreshToken: "rtk_old_refresh",
    authMethod: "loopback",
    expiresAt: 4_102_444_800_000, // year 2100 — far future unless overridden
    audience: "https://api.webhook.co",
    clientId: "client_abc",
    ...over,
  },
});

const rotatedBody = {
  access_token: "whk_new_access",
  token_type: "Bearer",
  expires_in: 86400,
  refresh_token: "rtk_new_refresh",
  scope: "events:read",
  resource: "https://api.webhook.co",
};

/** A fetch that returns the rotated FrozenTokenBody and counts how many times it was called. */
function refreshFetch(
  body: unknown = rotatedBody,
  status = 200,
): {
  fetch: typeof fetch;
  calls: () => number;
  lastBody: () => URLSearchParams;
} {
  let count = 0;
  let last = "";
  const f = (async (_url: string, init?: RequestInit) => {
    count += 1;
    last = String(init?.body);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => count, lastBody: () => new URLSearchParams(last) };
}

/** A store.set recorder. */
function setRecorder(throwOnSet = false): {
  set: (cred: StoredCredential, profile?: string) => Promise<void>;
  saved: () => StoredCredential | null;
  profile: () => string | undefined;
  calls: () => number;
} {
  let saved: StoredCredential | null = null;
  let profile: string | undefined;
  let count = 0;
  return {
    set: async (cred, p) => {
      count += 1;
      if (throwOnSet) throw new Error("disk full");
      saved = cred;
      profile = p;
    },
    saved: () => saved,
    profile: () => profile,
    calls: () => count,
  };
}

describe("createTokenManager — currentBearer (proactive)", () => {
  it("returns the stored access key when the token is not near expiry (no refresh)", async () => {
    const fetch = refreshFetch();
    const store = setRecorder();
    const m = createTokenManager({
      cred: oauthCred(),
      profile: "default",
      store,
      fetch: fetch.fetch,
      authBaseUrl: AUTH_BASE,
      now: () => 1_000_000,
    });
    expect(await m.currentBearer()).toBe("whk_old_access");
    expect(fetch.calls()).toBe(0);
    expect(store.calls()).toBe(0);
  });

  it("refreshes + persists the rotated credential when the token is expired", async () => {
    const fetch = refreshFetch();
    const store = setRecorder();
    const m = createTokenManager({
      cred: oauthCred({ expiresAt: 5_000 }),
      profile: "work",
      store,
      fetch: fetch.fetch,
      authBaseUrl: AUTH_BASE,
      now: () => 1_000_000,
    });
    expect(await m.currentBearer()).toBe("whk_new_access");
    expect(fetch.calls()).toBe(1);
    expect(fetch.lastBody().get("grant_type")).toBe("refresh_token");
    expect(fetch.lastBody().get("refresh_token")).toBe("rtk_old_refresh");
    // The whole rotated credential is persisted to the same profile.
    expect(store.profile()).toBe("work");
    const saved = store.saved();
    expect(saved).toMatchObject({
      oauth: { accessKey: "whk_new_access", refreshToken: "rtk_new_refresh" },
    });
  });

  it("refreshes inside the skew margin (expiry within REFRESH_SKEW_MS counts as due)", async () => {
    const fetch = refreshFetch();
    const now = 1_000_000;
    const m = createTokenManager({
      cred: oauthCred({ expiresAt: now + REFRESH_SKEW_MS - 1 }),
      profile: "default",
      store: setRecorder(),
      fetch: fetch.fetch,
      authBaseUrl: AUTH_BASE,
      now: () => now,
    });
    expect(await m.currentBearer()).toBe("whk_new_access");
    expect(fetch.calls()).toBe(1);
  });
});

describe("createTokenManager — refreshAuth (reactive) + single-flight", () => {
  it("returns the rotated bearer and persists it", async () => {
    const fetch = refreshFetch();
    const store = setRecorder();
    const m = createTokenManager({
      cred: oauthCred(),
      profile: "default",
      store,
      fetch: fetch.fetch,
      authBaseUrl: AUTH_BASE,
    });
    expect(await m.refreshAuth()).toBe("whk_new_access");
    expect(store.saved()).toMatchObject({ oauth: { accessKey: "whk_new_access" } });
  });

  it("single-flights concurrent refreshes into ONE token call", async () => {
    const fetch = refreshFetch();
    const m = createTokenManager({
      cred: oauthCred(),
      profile: "default",
      store: setRecorder(),
      fetch: fetch.fetch,
      authBaseUrl: AUTH_BASE,
    });
    const [a, b] = await Promise.all([m.refreshAuth(), m.refreshAuth()]);
    expect(a).toBe("whk_new_access");
    expect(b).toBe("whk_new_access");
    expect(fetch.calls()).toBe(1); // the rotating handle is consumed exactly once
  });

  it("single-flights even when the token call is genuinely async (deferred fetch)", async () => {
    // A fetch that resolves only when we release it — so both callers are in flight BEFORE the first
    // settles, proving the in-flight promise is shared (not just coalesced by a synchronous fake).
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let count = 0;
    const fetch = (async () => {
      count += 1;
      await gate;
      return new Response(JSON.stringify(rotatedBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const m = createTokenManager({
      cred: oauthCred({ expiresAt: 0 }), // expired → currentBearer() also joins the refresh
      profile: "default",
      store: setRecorder(),
      fetch,
      authBaseUrl: AUTH_BASE,
    });
    const pending = Promise.all([m.refreshAuth(), m.refreshAuth(), m.currentBearer()]);
    release();
    const [a, b, c] = await pending;
    expect([a, b, c]).toEqual(["whk_new_access", "whk_new_access", "whk_new_access"]);
    expect(count).toBe(1); // all three shared the one in-flight refresh
  });

  it("allows a fresh refresh after the in-flight one settles", async () => {
    const fetch = refreshFetch();
    const m = createTokenManager({
      cred: oauthCred(),
      profile: "default",
      store: setRecorder(),
      fetch: fetch.fetch,
      authBaseUrl: AUTH_BASE,
    });
    await m.refreshAuth();
    await m.refreshAuth();
    expect(fetch.calls()).toBe(2);
  });

  it("surfaces invalid_grant (a dead/consumed refresh) as an OAuthError → re-login", async () => {
    const fetch = refreshFetch({ error: "invalid_grant" }, 400);
    const m = createTokenManager({
      cred: oauthCred({ expiresAt: 0 }),
      profile: "default",
      store: setRecorder(),
      fetch: fetch.fetch,
      authBaseUrl: AUTH_BASE,
      now: () => 1_000_000,
    });
    await expect(m.currentBearer()).rejects.toMatchObject({ code: "invalid_grant" });
  });

  it("propagates a persist failure (the crash window): a thrown store.set surfaces, never a half-state", async () => {
    // The issuer ALWAYS rotates, so if persistence fails after the 200 the old refresh is already dead;
    // the error must propagate (the next run sends the dead handle → invalid_grant → clean re-login).
    const fetch = refreshFetch();
    const store = setRecorder(true);
    const m = createTokenManager({
      cred: oauthCred(),
      profile: "default",
      store,
      fetch: fetch.fetch,
      authBaseUrl: AUTH_BASE,
    });
    await expect(m.refreshAuth()).rejects.toThrow("disk full");
    expect(store.calls()).toBe(1);
  });
});
