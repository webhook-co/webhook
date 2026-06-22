import { describe, expect, it } from "vitest";

import type { OAuthCredential, StoredCredential } from "../config/schema.js";
import type { CredentialStore } from "../config/store.js";
import { bindAuth } from "./auth-binding.js";

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

function refreshFetch(): { fetch: typeof fetch; calls: () => number } {
  let count = 0;
  const f = (async () => {
    count += 1;
    return new Response(JSON.stringify(rotatedBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => count };
}

function memStore(): CredentialStore & { saved: () => StoredCredential | null } {
  let saved: StoredCredential | null = null;
  return {
    saved: () => saved,
    get: async () => saved,
    set: async (c) => void (saved = c),
    erase: async () => void (saved = null),
    list: async () => [],
    getApiBaseUrl: async () => undefined,
    setApiBaseUrl: async () => {},
  };
}

const neverFetch = (async () => {
  throw new Error("fetch should not be called");
}) as unknown as typeof fetch;

describe("bindAuth", () => {
  it("returns a static bearer and NO refresh hook for an API-key credential", async () => {
    const bound = await bindAuth({
      cred: { apiKey: "whk_plain_key" },
      profile: "default",
      store: memStore(),
      fetch: neverFetch,
    });
    expect(bound.bearer).toBe("whk_plain_key");
    expect(bound.refreshAuth).toBeUndefined();
  });

  it("returns the access key + a refresh hook for a fresh OAuth credential (no proactive refresh)", async () => {
    const f = refreshFetch();
    const bound = await bindAuth({
      cred: oauthCred(),
      profile: "default",
      store: memStore(),
      fetch: f.fetch,
    });
    expect(bound.bearer).toBe("whk_old_access");
    expect(bound.refreshAuth).toBeTypeOf("function");
    expect(f.calls()).toBe(0); // far-future expiry → no proactive refresh
  });

  it("proactively refreshes + persists when the OAuth token is expired", async () => {
    const f = refreshFetch();
    const store = memStore();
    const bound = await bindAuth({
      cred: oauthCred({ expiresAt: 0 }),
      profile: "work",
      store,
      fetch: f.fetch,
    });
    expect(bound.bearer).toBe("whk_new_access");
    expect(f.calls()).toBe(1);
    expect(store.saved()).toMatchObject({ oauth: { accessKey: "whk_new_access" } });
  });

  it("the returned refresh hook drives a (reactive) refresh", async () => {
    const f = refreshFetch();
    const bound = await bindAuth({
      cred: oauthCred(),
      profile: "default",
      store: memStore(),
      fetch: f.fetch,
    });
    expect(await bound.refreshAuth?.()).toBe("whk_new_access");
    expect(f.calls()).toBe(1);
  });
});
