import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import type { OAuthCredential, StoredCredential } from "../config/schema.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";
import { app } from "../app.js";

const OAUTH: OAuthCredential = {
  oauth: {
    accessKey: "whk_oauth_access",
    refreshToken: "rtk_secret_refresh",
    authMethod: "loopback",
    expiresAt: 1_700_000_000_000,
    audience: "https://api.webhook.co",
    clientId: "client_abc",
  },
};

/** A memory store that tracks whether erase() ran. */
function memStore(
  initial: StoredCredential | null = null,
): CredentialStore & { erased: () => boolean } {
  let cred = initial;
  let baseUrl: string | undefined;
  let erased = false;
  return {
    erased: () => erased,
    get: async () => cred,
    set: async (c) => void (cred = c),
    erase: async () => {
      erased = true;
      cred = null;
    },
    list: async () => (cred ? ["default"] : []),
    getApiBaseUrl: async () => baseUrl,
    setApiBaseUrl: async (u) => void (baseUrl = u),
    getOrg: async () => undefined,
    setOrg: async () => undefined,
  };
}

/** A fetch that records the revoke call. */
function recordingFetch(res: Response = new Response(null, { status: 200 })): {
  fetch: typeof fetch;
  calls: () => number;
  url: () => string;
  token: () => string | null;
} {
  let count = 0;
  let captured: { url: string; body: string } = { url: "", body: "" };
  const f = (async (url: string, init?: RequestInit) => {
    count += 1;
    captured = { url, body: String(init?.body) };
    return res;
  }) as unknown as typeof fetch;
  return {
    fetch: f,
    calls: () => count,
    url: () => captured.url,
    token: () => new URLSearchParams(captured.body).get("token"),
  };
}

describe("wbhk logout", () => {
  it("revokes the refresh token server-side then clears the local credential (OAuth)", async () => {
    const store = memStore(OAUTH);
    const rec = recordingFetch();
    const t = makeTestContext({ store, fetch: rec.fetch });
    await run(app, ["logout"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(rec.calls()).toBe(1);
    expect(rec.url()).toBe("https://auth.webhook.co/revoke");
    expect(rec.token()).toBe("rtk_secret_refresh"); // the refresh handle is what's revoked
    expect(store.erased()).toBe(true);
    expect(t.stdout()).toContain("logged out (token revoked)");
    expect(t.stdout()).not.toContain("rtk_"); // never echoed
  });

  it("clears an API-key credential LOCALLY without calling revoke", async () => {
    const store = memStore({ apiKey: "whk_local_key" });
    const rec = recordingFetch();
    const t = makeTestContext({ store, fetch: rec.fetch });
    await run(app, ["logout"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(rec.calls()).toBe(0); // api keys may be dashboard-issued/shared — never revoked from here
    expect(store.erased()).toBe(true);
    expect(t.stdout()).toContain("logged out");
    expect(t.stdout()).not.toContain("token revoked");
  });

  it("says there is nothing to do when not logged in (no erase, no revoke)", async () => {
    const store = memStore(null);
    const rec = recordingFetch();
    const t = makeTestContext({ store, fetch: rec.fetch });
    await run(app, ["logout"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(rec.calls()).toBe(0);
    expect(store.erased()).toBe(false);
    expect(t.stderr().toLowerCase()).toContain("not logged in");
  });

  it("still clears the local credential when the server-side revoke fails (best-effort)", async () => {
    const store = memStore(OAUTH);
    const failingFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const t = makeTestContext({ store, fetch: failingFetch });
    await run(app, ["logout"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(store.erased()).toBe(true);
    expect(t.stderr().toLowerCase()).toContain("could not revoke");
    expect(t.stdout()).toContain("logged out");
  });

  it("reports honestly (not a clean logout) when WBHK_API_KEY still grants access", async () => {
    const store = memStore({ apiKey: "whk_local_key" });
    const rec = recordingFetch();
    const t = makeTestContext({ store, fetch: rec.fetch, env: { WBHK_API_KEY: "whk_env_key" } });
    await run(app, ["logout"], t.ctx);
    expect(store.erased()).toBe(true); // any on-disk credential is still cleared
    // The headline must NOT claim a clean logout — the env var outranks the store and remains active.
    expect(t.stdout()).toContain("WBHK_API_KEY");
    expect(t.stdout()).toContain("cleared the stored credential");
    expect(t.stdout()).not.toMatch(/^logged out\.?$/m);
  });

  it("honors --auth-url for the revoke endpoint", async () => {
    const store = memStore(OAUTH);
    const rec = recordingFetch();
    const t = makeTestContext({ store, fetch: rec.fetch });
    await run(app, ["logout", "--auth-url", "https://auth.example.test"], t.ctx);
    expect(rec.url()).toBe("https://auth.example.test/revoke");
    expect(store.erased()).toBe(true);
  });

  it("targets a specific login via --profile (logout is org-selector-exempt — no --org)", async () => {
    // logout is profile-only + DESTRUCTIVE, so it deliberately does NOT carry --org (which would over-apply
    // the strict org selector to a purely-local cleanup). `--profile` names the login to sign out of.
    const creds: Record<string, StoredCredential | null> = {
      prod: { apiKey: "whk_prod" },
      "acme-p": { apiKey: "whk_acme" },
    };
    let erasedProfile: string | undefined;
    const store: CredentialStore = {
      get: async (p = "default") => creds[p] ?? null,
      set: async () => undefined,
      erase: async (p = "default") => void (erasedProfile = p),
      list: async () => Object.keys(creds),
      getApiBaseUrl: async () => undefined,
      setApiBaseUrl: async () => undefined,
      getActiveProfile: async () => "prod",
      getOrg: async () => undefined,
      setOrg: async () => undefined,
    };
    const t = makeTestContext({ store, fetch: recordingFetch().fetch });
    await run(app, ["logout", "--profile", "acme-p"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(erasedProfile).toBe("acme-p"); // the named profile, not the active prod
  });

  it("works while WBHK_API_KEY + an ambient WBHK_ORG are set (a local cleanup is never bricked)", async () => {
    // Regression: routing logout through the strict org selector used to hard-fail here. logout is
    // profile-only, so an unrelated env key / org env never blocks erasing a stored credential.
    const store = memStore({ apiKey: "whk_local" });
    const t = makeTestContext({
      store,
      fetch: recordingFetch().fetch,
      env: { WBHK_API_KEY: "whk_env", WBHK_ORG: "acme" },
    });
    await run(app, ["logout"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(store.erased()).toBe(true);
  });
});
