import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

// Valid v4 UUIDs so the shared contract schemas accept the fixtures.
const ORG = "22222222-2222-4222-8222-222222222222";
const EP1 = "11111111-1111-4111-8111-111111111111";
const EP2 = "11111111-1111-4111-8111-111111111112";

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
function sequenceFetch(...responses: Response[]): typeof fetch {
  let i = 0;
  return (async () => responses[Math.min(i++, responses.length - 1)]) as unknown as typeof fetch;
}
function capturingFetch(body: unknown): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return json(body);
  }) as unknown as typeof fetch;
  return { fetch, urls };
}

const endpoint = (id: string, name: string, paused = false) => ({
  id,
  orgId: ORG,
  name,
  paused,
  createdAt: "2026-05-01T00:00:00.000Z",
});

describe("wbhk endpoints list", () => {
  it("renders a table with a status word", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [endpoint(EP1, "orders-prod")], nextCursor: null }),
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("NAME");
    expect(t.stdout()).toContain("orders-prod");
    expect(t.stdout()).toContain("active");
  });

  it("emits the {items,nextCursor} envelope with --output json", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [endpoint(EP1, "orders-prod")], nextCursor: "c_next" }),
    });
    await run(app, ["endpoints", "list", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout());
    expect(parsed.nextCursor).toBe("c_next");
    expect(parsed.items[0].id).toBe(EP1);
  });

  it("passes the --name filter through as a query param", async () => {
    const cap = capturingFetch({ items: [], nextCursor: null });
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["endpoints", "list", "--name", "orders"], t.ctx);
    const u = new URL(cap.urls[0]);
    expect(u.pathname).toBe("/v1/endpoints");
    expect(u.searchParams.get("name")).toBe("orders");
  });

  it("prints a stderr hint (stdout stays clean of the token) when more results exist", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [endpoint(EP1, "a")], nextCursor: "tok_123" }),
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(t.stderr()).toContain("more results");
    expect(t.stdout()).not.toContain("tok_123");
  });

  it("--output json keeps stdout a single pure JSON value with NO stderr noise (script-safe)", async () => {
    // Even with a nextCursor, json mode puts it in the envelope (not a stderr hint), so stdout stays
    // a single parseable value and stderr stays empty — the strict stdout=data/stderr=everything rule.
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [endpoint(EP1, "a")], nextCursor: "tok_123" }),
    });
    await run(app, ["endpoints", "list", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout()) as { items: unknown[]; nextCursor: string };
    expect(parsed.nextCursor).toBe("tok_123");
    expect(t.stdout()).not.toContain("more results");
    expect(t.stdout().trimEnd()).not.toContain("\n"); // compact: one JSON value on one line
    expect(t.stderr()).toBe("");
  });

  it("--all follows the cursor across pages and shows all rows without a hint", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: sequenceFetch(
        json({ items: [endpoint(EP1, "page-one")], nextCursor: "c2" }),
        json({ items: [endpoint(EP2, "page-two")], nextCursor: null }),
      ),
    });
    await run(app, ["endpoints", "list", "--all"], t.ctx);
    expect(t.stdout()).toContain("page-one");
    expect(t.stdout()).toContain("page-two");
    expect(t.stderr()).not.toContain("more results");
  });

  it("--all stops safely if the server returns a non-advancing cursor", async () => {
    // okFetch returns the SAME nextCursor on every call; the guard must break, not loop forever.
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [endpoint(EP1, "stuck")], nextCursor: "stable" }),
    });
    await run(app, ["endpoints", "list", "--all"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("stuck");
  });

  it("prints a friendly line for an empty page", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(t.stdout()).toContain("no endpoints.");
  });

  it("requires a credential (NotLoggedInError → UNAUTHORIZED exit)", async () => {
    const t = makeTestContext({ store: emptyStore() });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
    expect(t.stderr().toLowerCase()).toContain("not logged in");
  });

  it("rejects a non-numeric --limit as a usage error", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list", "--limit", "abc"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
  });
});

describe("wbhk endpoints get", () => {
  it("renders a single endpoint as a key:value block", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch(endpoint(EP1, "orders-prod", true)),
    });
    await run(app, ["endpoints", "get", EP1], t.ctx);
    expect(t.stdout()).toContain("name:");
    expect(t.stdout()).toContain("orders-prod");
    expect(t.stdout()).toContain("paused");
  });

  it("maps a 404 to the NOT_FOUND exit code", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(404) });
    await run(app, ["endpoints", "get", EP1], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.NOT_FOUND);
    expect(t.stderr().toLowerCase()).toContain("not found");
  });
});

describe("wbhk endpoints create", () => {
  const created = {
    id: EP1,
    orgId: ORG,
    name: "orders-prod",
    paused: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    ingestUrl: "https://wbhk.my/whep_one_time_secret_token_value_aaaaaaaaaaaa",
  };

  it("reveals the ingest url on stdout and the save-it caveat on stderr (pipe-safe)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(created) });
    await run(app, ["endpoints", "create", "orders-prod"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    // The record (with the one-time ingest url) is on stdout.
    expect(t.stdout()).toContain("ingest url");
    expect(t.stdout()).toContain(created.ingestUrl);
    expect(t.stdout()).toContain("orders-prod");
    // The save-it caveat is on stderr only — stdout stays a clean record.
    expect(t.stderr().toLowerCase()).toContain("save");
    expect(t.stderr().toLowerCase()).toContain("once");
    expect(t.stdout().toLowerCase()).not.toContain("save the ingest url");
  });

  it("emits the full record (incl. ingestUrl) as one JSON value with --output json, no stderr noise", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(created) });
    await run(app, ["endpoints", "create", "orders-prod", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout()) as { id: string; ingestUrl: string };
    expect(parsed.id).toBe(EP1);
    expect(parsed.ingestUrl).toBe(created.ingestUrl);
    expect(t.stderr()).toBe(""); // script-safe: nothing on stderr in json mode
  });

  it("requires a credential (NotLoggedInError → UNAUTHORIZED exit)", async () => {
    const t = makeTestContext({ store: emptyStore() });
    await run(app, ["endpoints", "create", "orders-prod"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
    expect(t.stderr().toLowerCase()).toContain("not logged in");
  });

  it("maps a 429 (per-org soft cap) to the RATE_LIMITED exit code", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(429) });
    await run(app, ["endpoints", "create", "orders-prod"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.RATE_LIMITED);
  });
});

describe("wbhk endpoints delete", () => {
  const deleted = { id: EP1, deletedAt: "2026-05-01T00:00:00.000Z" };

  it("with --yes, soft-deletes and prints the {id, deleted} record", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(deleted) });
    await run(app, ["endpoints", "delete", EP1, "--yes"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("deleted");
    expect(t.stdout()).toContain(EP1);
  });

  it("emits the record as one JSON value with --output json (no stderr noise)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(deleted) });
    await run(app, ["endpoints", "delete", EP1, "--yes", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout()) as { id: string; deletedAt: string };
    expect(parsed.id).toBe(EP1);
    expect(t.stderr()).toBe("");
  });

  it("refuses without --yes in a non-TTY (usage error) and never calls the api", async () => {
    // Default makeTestContext: isInteractive=false, and io.fetch throws if ever called.
    const t = makeTestContext({ store: loggedInStore() });
    await run(app, ["endpoints", "delete", EP1], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("--yes");
  });

  it("prompts in an interactive TTY and proceeds when the user types 'yes'", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch(deleted),
      lineResponse: "yes",
    });
    await run(app, ["endpoints", "delete", EP1], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain(EP1);
  });

  it("aborts (usage error) when the interactive confirmation is declined", async () => {
    const t = makeTestContext({ store: loggedInStore(), lineResponse: "no" });
    await run(app, ["endpoints", "delete", EP1], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("aborted");
  });

  it("maps a 404 to the NOT_FOUND exit code", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: statusFetch(404) });
    await run(app, ["endpoints", "delete", EP1, "--yes"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.NOT_FOUND);
  });

  it("requires a credential (NotLoggedInError → UNAUTHORIZED exit)", async () => {
    const t = makeTestContext({ store: emptyStore() });
    await run(app, ["endpoints", "delete", EP1, "--yes"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });
});

describe("wbhk endpoints rotate", () => {
  const rotated = {
    id: EP1,
    orgId: ORG,
    name: "orders-prod",
    paused: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    ingestUrl: "https://wbhk.my/whep_rotated_secret_token_value_bbbbbbbbbbbb",
  };

  it("with --yes, reveals the NEW ingest url on stdout and the caveat on stderr (pipe-safe)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(rotated) });
    await run(app, ["endpoints", "rotate", EP1, "--yes"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain(rotated.ingestUrl);
    expect(t.stderr().toLowerCase()).toContain("save");
    expect(t.stderr().toLowerCase()).toContain("previous url"); // the old url is dead (hard cutover)
  });

  it("refuses without --yes in a non-TTY (usage error) and never calls the api", async () => {
    const t = makeTestContext({ store: loggedInStore() });
    await run(app, ["endpoints", "rotate", EP1], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("--yes");
  });

  it("emits the full record (incl. new ingestUrl) as one JSON value with --output json", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(rotated) });
    await run(app, ["endpoints", "rotate", EP1, "--yes", "--output", "json"], t.ctx);
    const parsed = JSON.parse(t.stdout()) as { id: string; ingestUrl: string };
    expect(parsed.id).toBe(EP1);
    expect(parsed.ingestUrl).toBe(rotated.ingestUrl);
    expect(t.stderr()).toBe("");
  });
});

describe("global --color / --no-color (end to end)", () => {
  const ANSI = "["; // any ANSI escape

  it("--color forces ANSI in the table even when the context resolved color off (not a TTY)", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [endpoint(EP1, "orders-prod")], nextCursor: null }),
    });
    await run(app, ["endpoints", "list", "--color"], t.ctx);
    expect(t.stdout()).toContain(ANSI);
  });

  it("--no-color suppresses ANSI", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [endpoint(EP1, "orders-prod")], nextCursor: null }),
    });
    await run(app, ["endpoints", "list", "--no-color"], t.ctx);
    expect(t.stdout()).not.toContain(ANSI);
  });
});

describe("global --profile (end to end)", () => {
  // A profile-aware store: each profile holds a distinct credential, so the resolved profile is
  // observable in the request's Authorization header.
  function profileStore(creds: Record<string, string>): CredentialStore {
    return {
      get: async (profile = "default") =>
        creds[profile] !== undefined ? { apiKey: creds[profile] } : null,
      set: async () => undefined,
      erase: async () => undefined,
      list: async () => Object.keys(creds),
      getApiBaseUrl: async () => undefined,
      setApiBaseUrl: async () => undefined,
    };
  }

  it("--profile selects that profile's stored credential for the request", async () => {
    let auth: string | null = null;
    const capturingFetch = (async (_url: string, init?: { headers?: HeadersInit }) => {
      auth = new Headers(init?.headers).get("authorization");
      return json({ items: [], nextCursor: null });
    }) as unknown as typeof fetch;
    const t = makeTestContext({
      store: profileStore({ default: "whk_default", staging: "whk_staging" }),
      fetch: capturingFetch,
    });
    await run(app, ["endpoints", "list", "--profile", "staging"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(auth).toContain("whk_staging");
    expect(auth).not.toContain("whk_default");
  });

  it("falls back to the default profile when --profile is absent", async () => {
    let auth: string | null = null;
    const capturingFetch = (async (_url: string, init?: { headers?: HeadersInit }) => {
      auth = new Headers(init?.headers).get("authorization");
      return json({ items: [], nextCursor: null });
    }) as unknown as typeof fetch;
    const t = makeTestContext({
      store: profileStore({ default: "whk_default", staging: "whk_staging" }),
      fetch: capturingFetch,
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(auth).toContain("whk_default");
  });

  it("notes the active profile on stderr when it is not the default", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      env: { WBHK_PROFILE: "staging" },
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(t.stderr().toLowerCase()).toContain("profile");
    expect(t.stderr()).toContain("staging");
    expect(t.stdout()).not.toContain("staging"); // the banner stays off stdout (pipe-safe)
  });

  it("stays silent about the profile for the default profile", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(t.stderr().toLowerCase()).not.toContain("profile");
  });
});
