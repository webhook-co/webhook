import { run } from "@stricli/core";
import { bytesToB64 } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import { CorruptConfigError } from "../config/errors.js";
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
    getOrg: async () => undefined,
    setOrg: async () => undefined,
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
        getOrg: async () => undefined,
        setOrg: async () => undefined,
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

  it("the default (non-json) mode prints the decoded body readably — the human view for #2", async () => {
    const text = '{\n    "name": "test"\n}';
    const body = new TextEncoder().encode(text);
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(envelope(body)) });
    await run(app, ["events", "payload", EV], t.ctx);
    expect(t.stdout()).toBe(text); // readable, exactly like the dashboard — no --output json needed
  });

  it("--output json stays the lossless contract envelope (contentType/bytes/bodyBase64 only — SDK parity)", async () => {
    const body = new TextEncoder().encode('{"order":42}');
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(envelope(body)) });
    await run(app, ["events", "payload", EV, "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout());
    expect(Object.keys(parsed).sort()).toEqual(["bodyBase64", "bytes", "contentType"]);
    expect(parsed.bodyBase64).toBe(bytesToB64(body));
  });

  it("targets the /payload path", async () => {
    const cap = capturingFetch(envelope(new TextEncoder().encode("x")));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["events", "payload", EV], t.ctx);
    expect(new URL(cap.urls[0]).pathname).toBe(`/v1/events/${EV}/payload`);
  });
});

describe("wbhk events open", () => {
  const SLUG = "choraria";
  const EXPECTED_URL = `https://app.webhook.co/org/${SLUG}/endpoints/${EP}/events/${EV}`;
  // The slug comes from the EFFECTIVE org (the profile's persisted metadata here) — a purely LOCAL read, no
  // whoami on the path. `events open` only fetches the event (for its endpointId).
  function storeWithOrg(slug: string | undefined): CredentialStore {
    const store = loggedInStore();
    store.getOrg = async () =>
      slug === undefined ? undefined : { id: ORG, slug, name: "Choraria" };
    return store;
  }

  it("opens the /org/<slug>/endpoints/<endpointId>/events/<eventId> dashboard url (local slug, no whoami)", async () => {
    const opened: string[] = [];
    const cap = capturingFetch(fullEvent);
    const t = makeTestContext({
      store: storeWithOrg(SLUG),
      fetch: cap.fetch,
      openBrowser: async (u) => void opened.push(u),
    });
    await run(app, ["events", "open", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(opened).toEqual([EXPECTED_URL]);
    // only the event is fetched — no /v1/whoami on the open path
    expect(cap.urls.every((u) => !new URL(u).pathname.endsWith("/whoami"))).toBe(true);
  });

  it("with --print, writes the url to stdout and does NOT open a browser", async () => {
    const opened: string[] = [];
    const t = makeTestContext({
      store: storeWithOrg(SLUG),
      fetch: okFetch(fullEvent),
      openBrowser: async (u) => void opened.push(u),
    });
    await run(app, ["events", "open", EV, "--print"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(opened).toEqual([]);
    expect(t.stdout().trim()).toBe(EXPECTED_URL);
  });

  it("with --output json, emits a {url} envelope and does NOT open a browser (machine contract)", async () => {
    const opened: string[] = [];
    const t = makeTestContext({
      store: storeWithOrg(SLUG),
      fetch: okFetch(fullEvent),
      openBrowser: async (u) => void opened.push(u),
    });
    await run(app, ["events", "open", EV, "--output", "json"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(opened).toEqual([]); // json = data, not an interactive side effect
    expect(JSON.parse(t.stdout())).toEqual({ url: EXPECTED_URL });
  });

  it("guides the user to `wbhk whoami` (no broken link, no event fetch) when there is no persisted org", async () => {
    const opened: string[] = [];
    const cap = capturingFetch(fullEvent);
    const t = makeTestContext({
      store: storeWithOrg(undefined),
      fetch: cap.fetch,
      openBrowser: async (u) => void opened.push(u),
    });
    await run(app, ["events", "open", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(opened).toEqual([]);
    expect(t.stderr().toLowerCase()).toContain("whoami");
    expect(cap.urls).toEqual([]); // short-circuits before hitting the api
  });

  it("exits USAGE (not UNEXPECTED) when no org resolves — a user-actionable state, not an internal fault", async () => {
    const t = makeTestContext({ store: storeWithOrg(undefined), fetch: okFetch(fullEvent) });
    await run(app, ["events", "open", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.UNEXPECTED);
  });

  it("under WBHK_API_KEY (env cred) resolves the slug from whoami — NEVER the untrusted local store org", async () => {
    const opened: string[] = [];
    // the local store holds a DIFFERENT org — an env key's real org is server-side, so this must be ignored
    const store = loggedInStore();
    store.getOrg = async () => ({ id: ORG, slug: "wrong-local-org", name: "Wrong" });
    const t = makeTestContext({
      store,
      env: { WBHK_API_KEY: "whk_env" },
      fetch: (async (url: string | URL | Request) => {
        const p = new URL(String(url)).pathname;
        if (p === "/v1/whoami")
          return json({
            orgId: ORG,
            scopes: ["events:read"],
            organization: { id: ORG, slug: "env-org", name: "Env" },
          });
        return json(fullEvent);
      }) as unknown as typeof fetch,
      openBrowser: async (u) => void opened.push(u),
    });
    await run(app, ["events", "open", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(opened).toEqual([`https://app.webhook.co/org/env-org/endpoints/${EP}/events/${EV}`]);
    expect(opened[0]).not.toContain("wrong-local-org"); // the wrong local org was never used
  });

  it("under an env cred, a whoami auth failure surfaces as the REAL error — not a misleading org message", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      env: { WBHK_API_KEY: "whk_bad" },
      fetch: (async (url: string | URL | Request) => {
        const p = new URL(String(url)).pathname;
        if (p === "/v1/whoami") return json({ error: "unauthorized" }, 401);
        return json(fullEvent);
      }) as unknown as typeof fetch,
    });
    await run(app, ["events", "open", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
    expect(t.stderr().toLowerCase()).not.toContain("run `wbhk whoami`"); // not the org-guidance red herring
  });

  it("surfaces a fail-loud corrupt-config error instead of masking it as an org problem", async () => {
    const store = loggedInStore();
    store.getOrg = async () => {
      throw new CorruptConfigError("bad json");
    };
    const t = makeTestContext({ store, fetch: okFetch(fullEvent) });
    await run(app, ["events", "open", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("unreadable"); // the actionable config message…
    expect(t.stderr().toLowerCase()).not.toContain("whoami"); // …not the org-guidance red herring
  });

  it("under an env cred whose whoami omits the org, points to the dashboard (NOT the dead-end run-whoami)", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      env: { WBHK_API_KEY: "whk_env" },
      fetch: (async (url: string | URL | Request) => {
        const p = new URL(String(url)).pathname;
        if (p === "/v1/whoami") return json({ orgId: ORG, scopes: ["events:read"] }); // no organization
        return json(fullEvent);
      }) as unknown as typeof fetch,
    });
    await run(app, ["events", "open", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("dashboard");
    expect(t.stderr().toLowerCase()).not.toContain("run `wbhk whoami`"); // env creds persist nothing
  });
});

describe("events delete", () => {
  const deleted = { id: EV, deletedAt: "2026-07-11T00:00:00.000Z" };

  it("with --yes, deletes the event and prints the {id, deletedAt} record", async () => {
    const cap = capturingFetch(deleted);
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["events", "delete", EV, "--yes"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(cap.urls[0]).toContain(`/v1/events/${EV}`);
    expect(t.stdout()).toContain(EV);
  });

  it("refuses without --yes in a non-TTY (usage error) and never calls the api", async () => {
    // Default makeTestContext: isInteractive=false, and io.fetch throws if ever called → destructive-safe.
    const t = makeTestContext({ store: loggedInStore() });
    await run(app, ["events", "delete", EV], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("--yes");
  });
});
