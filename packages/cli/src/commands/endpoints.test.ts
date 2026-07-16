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
    getOrg: async () => undefined,
    setOrg: async () => undefined,
  };
}

/** A logged-in store whose default profile carries a bound org. */
function loggedInOrgStore(): CredentialStore {
  const s = loggedInStore();
  return { ...s, getOrg: async () => ({ id: "org_1", slug: "acme", name: "Acme, Inc." }) };
}

function emptyStore(): CredentialStore {
  return {
    get: async () => null,
    set: async () => undefined,
    erase: async () => undefined,
    list: async () => [],
    getApiBaseUrl: async () => undefined,
    setApiBaseUrl: async () => undefined,
    getOrg: async () => undefined,
    setOrg: async () => undefined,
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
  dedupConfig: null,
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
    dedupConfig: null,
    ingestUrl: "https://wbhk.my/whep_sealed_secret_token_value_aaaaaaaaaaaa",
  };

  it("prints the ingest url on stdout and the reveal-it-later hint on stderr (pipe-safe)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(created) });
    await run(app, ["endpoints", "create", "orders-prod"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    // The record (with the ingest url) is on stdout.
    expect(t.stdout()).toContain("ingest url");
    expect(t.stdout()).toContain(created.ingestUrl);
    expect(t.stdout()).toContain("orders-prod");
    // The hint is on stderr only — stdout stays a clean record — and it points at the reveal command
    // (with this endpoint's real id) rather than telling the user to save a "one-time" secret.
    expect(t.stderr()).toContain(`wbhk endpoints reveal ${EP1}`);
    expect(t.stdout()).not.toContain("wbhk endpoints reveal");
  });

  // ADR-0101 reversed the one-time reveal: the ingest token is sealed at rest and the URL is retrievable
  // any time (`endpoints reveal` / the dashboard). Copy that still calls it a one-time secret is a LIE that
  // sends users to rotate a URL they never lost — pin the retraction so it cannot regress.
  it("never claims the ingest url is one-time or unrecoverable", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(created) });
    await run(app, ["endpoints", "create", "orders-prod"], t.ctx);
    const all = `${t.stdout()}${t.stderr()}`.toLowerCase();
    expect(all).not.toContain("once");
    expect(all).not.toContain("recover");
    expect(all).not.toContain("save the ingest url");
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

  // The CLI no longer narrates its target org on every command. `wbhk whoami` is the one place that
  // reports the bound org — an echo on each command was noise, not information, since the org is fixed by
  // the credential and only changes when you pass an explicit `--org`.
  it("does NOT echo a `targeting org` banner on a mutating command", async () => {
    const t = makeTestContext({ store: loggedInOrgStore(), fetch: okFetch(created) });
    await run(app, ["endpoints", "create", "orders-prod"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stderr()).not.toContain("targeting org");
    expect(t.stdout()).not.toContain("targeting org");
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
    dedupConfig: null,
    ingestUrl: "https://wbhk.my/whep_rotated_secret_token_value_bbbbbbbbbbbb",
  };

  it("with --yes, reveals the NEW ingest url on stdout and the caveat on stderr (pipe-safe)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(rotated) });
    await run(app, ["endpoints", "rotate", EP1, "--yes"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain(rotated.ingestUrl);
    expect(t.stderr().toLowerCase()).toContain("previous url"); // the old url is dead (hard cutover)
    // The surviving caveat is the REVOCATION, not a one-time reveal: the new url is retrievable any time.
    expect(t.stderr()).toContain(`wbhk endpoints reveal ${EP1}`);
    const all = `${t.stdout()}${t.stderr()}`.toLowerCase();
    expect(all).not.toContain("once");
    expect(all).not.toContain("recover");
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
      getOrg: async () => undefined,
      setOrg: async () => undefined,
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

describe("global --org selector (authed path, end to end)", () => {
  // A profile-aware store carrying each profile's bound ORG too, so the selector can be exercised e2e.
  function orgProfileStore(
    profiles: Record<string, { key: string; org?: { id: string; slug: string; name: string } }>,
  ): CredentialStore {
    return {
      get: async (p = "default") =>
        profiles[p] !== undefined ? { apiKey: profiles[p]!.key } : null,
      set: async () => undefined,
      erase: async () => undefined,
      list: async () => Object.keys(profiles),
      getApiBaseUrl: async () => undefined,
      setApiBaseUrl: async () => undefined,
      getOrg: async (p = "default") => profiles[p]?.org,
      setOrg: async () => undefined,
    };
  }
  const ACME = { id: "org_1", slug: "acme", name: "Acme, Inc." };
  const GLOBEX = { id: "org_2", slug: "globex", name: "Globex" };
  const twoOrgs = () =>
    orgProfileStore({
      default: { key: "whk_default" },
      prod: { key: "whk_prod", org: ACME },
      staging: { key: "whk_staging", org: GLOBEX },
    });
  function authCapturingFetch(): { fetch: typeof fetch; auth: () => string | null } {
    let auth: string | null = null;
    const fetch = (async (_url: string, init?: { headers?: HeadersInit }) => {
      auth = new Headers(init?.headers).get("authorization");
      return json({ items: [], nextCursor: null });
    }) as unknown as typeof fetch;
    return { fetch, auth: () => auth };
  }

  it("F3: `--profile staging` BEATS an ambient WBHK_ORG=acme — uses staging, no conflict error", async () => {
    const f = authCapturingFetch();
    const t = makeTestContext({ store: twoOrgs(), env: { WBHK_ORG: "acme" }, fetch: f.fetch });
    await run(app, ["endpoints", "list", "--profile", "staging"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(f.auth()).toContain("whk_staging"); // never resolved WBHK_ORG's profile (prod)
  });

  it("WBHK_ORG env (no flags) binds that org's profile", async () => {
    const f = authCapturingFetch();
    const t = makeTestContext({ store: twoOrgs(), env: { WBHK_ORG: "acme" }, fetch: f.fetch });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(f.auth()).toContain("whk_prod"); // acme → prod — the binding IS the invariant
    expect(t.stderr()).not.toContain("targeting org"); // …and it's no longer narrated
  });

  it("WBHK_ORG env pointing at a nonexistent org → OrgNotFound (actionable usage error)", async () => {
    const t = makeTestContext({
      store: twoOrgs(),
      env: { WBHK_ORG: "nonexistent" },
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("no local credential for org");
  });

  it("`--org acme` FLAG + a disagreeing `--profile staging` FLAG → conflict (usage error)", async () => {
    const t = makeTestContext({
      store: twoOrgs(),
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list", "--org", "acme", "--profile", "staging"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("disagree");
  });

  it("`--org acme` FLAG binds acme's profile", async () => {
    const f = authCapturingFetch();
    const t = makeTestContext({ store: twoOrgs(), fetch: f.fetch });
    await run(app, ["endpoints", "list", "--org", "acme"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(f.auth()).toContain("whk_prod");
  });

  it("C2: WBHK_API_KEY set + `--org acme` → OrgSelectorWithEnvKeyError (clear message), NOT OrgNotFound", async () => {
    const t = makeTestContext({
      store: twoOrgs(),
      env: { WBHK_API_KEY: "whk_env" },
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list", "--org", "acme"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    const err = t.stderr().toLowerCase();
    expect(err).toContain("cannot select an org"); // the env-key refusal, not "no local credential"
    expect(err).not.toContain("no local credential for org");
  });

  it("C2: WBHK_API_KEY set + explicit --org=acme → OrgSelectorWithEnvKeyError (explicit selector refused)", async () => {
    const t = makeTestContext({
      store: twoOrgs(),
      env: { WBHK_API_KEY: "whk_env" },
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list", "--org", "acme"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("cannot select an org");
  });

  it("R3: WBHK_API_KEY set + ambient WBHK_ORG (no --org flag) → runs on the env key, WBHK_ORG ignored (not bricked)", async () => {
    // A leftover WBHK_ORG must NOT hard-fail every authed command when WBHK_API_KEY is the credential.
    const t = makeTestContext({
      store: twoOrgs(),
      env: { WBHK_API_KEY: "whk_env", WBHK_ORG: "acme" },
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
  });

  it("C1/C6: WBHK_API_KEY set with an org-bound profile, NO org selector → still succeeds", async () => {
    // This used to assert "no `targeting org` banner". With the banner gone that assertion would pass
    // vacuously, so it now pins what this LAYER can actually observe: the env-credential path still runs a
    // command cleanly even when the local profile carries its own key and a bound org.
    //
    // The two invariants it LOOKED like it covered live where they can really be tested:
    //   - env-key read precedence over a profile's key → context.test.ts ("honors the env-var credential
    //     through the assembled store"); the fake store here doesn't model backend precedence.
    //   - never deriving an env key's org from the local store → global-flags.test.ts's resolveEffectiveOrg
    //     block ("NEVER reads the local store").
    const store = orgProfileStore({ default: { key: "whk_default", org: ACME } });
    const t = makeTestContext({
      store,
      env: { WBHK_API_KEY: "whk_env" },
      fetch: okFetch({ items: [], nextCursor: null }),
    });
    await run(app, ["endpoints", "list"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
  });
});

// A fetch mock that records method + parsed JSON body (capturingFetch only records URLs).
function capturingReq(body: unknown): {
  fetch: typeof fetch;
  calls: { url: string; method: string; body: unknown }[];
} {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body != null ? JSON.parse(String(init.body)) : undefined,
    });
    return json(body);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("wbhk endpoints update", () => {
  it("PATCHes the endpoint with the built dedup config for --dedup-mode off (no window)", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["endpoints", "update", EP1, "--dedup-mode", "off"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(cap.calls[0]?.method).toBe("PATCH");
    expect(cap.calls[0]?.url).toContain(`/v1/endpoints/${EP1}`);
    // off collapses nothing, so it carries no window at all.
    expect(cap.calls[0]?.body).toEqual({ dedupConfig: { mode: "off" } });
  });

  it("errors on --dedup-window with --dedup-mode off (no silent drop)", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(
      app,
      ["endpoints", "update", EP1, "--dedup-mode", "off", "--dedup-window", "300"],
      t.ctx,
    );
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(t.stderr().toLowerCase()).toMatch(/dedup-window.*off|off.*window/);
    expect(cap.calls).toHaveLength(0);
  });

  it("builds a fields config from --dedup-field + --dedup-window", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(
      app,
      [
        "endpoints",
        "update",
        EP1,
        "--dedup-mode",
        "fields",
        "--dedup-field",
        "body.id, body.x",
        "--dedup-window",
        "300",
      ],
      t.ctx,
    );
    expect(cap.calls[0]?.body).toEqual({
      dedupConfig: {
        mode: "fields",
        windowSeconds: 300,
        fields: { include: ["body.id", "body.x"] },
      },
    });
  });

  it("sends dedupConfig=null for --dedup-reset", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["endpoints", "update", EP1, "--dedup-reset"], t.ctx);
    expect(cap.calls[0]?.body).toEqual({ dedupConfig: null });
  });

  it("errors (no request) when neither --dedup-mode nor --dedup-reset is given", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["endpoints", "update", EP1], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(t.stderr().toLowerCase()).toMatch(/dedup-mode|dedup-reset/);
    expect(cap.calls).toHaveLength(0); // failed before any request
  });

  it("errors on --dedup-field with a non-fields mode (no silent drop)", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(
      app,
      ["endpoints", "update", EP1, "--dedup-mode", "identifier", "--dedup-field", "body.id"],
      t.ctx,
    );
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(cap.calls).toHaveLength(0);
  });

  it("errors on a sub-flag without --dedup-mode (no silent drop)", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["endpoints", "update", EP1, "--dedup-window", "300"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(cap.calls).toHaveLength(0);
  });

  it("errors on --dedup-reset combined with a config flag (contradiction)", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["endpoints", "update", EP1, "--dedup-reset", "--dedup-mode", "content"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(cap.calls).toHaveLength(0);
  });

  it("rejects a non-decimal --dedup-window (1e3) as a usage error", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(
      app,
      ["endpoints", "update", EP1, "--dedup-mode", "content", "--dedup-window", "1e3"],
      t.ctx,
    );
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(cap.calls).toHaveLength(0);
  });

  it("rejects an out-of-range --dedup-window at the CLI (before the request)", async () => {
    const cap = capturingReq(endpoint(EP1, "orders-prod"));
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(
      app,
      ["endpoints", "update", EP1, "--dedup-mode", "content", "--dedup-window", "5"],
      t.ctx,
    );
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).not.toBe(EXIT.SUCCESS);
    expect(cap.calls).toHaveLength(0);
  });
});

describe("wbhk endpoints create --dedup-*", () => {
  const created = {
    id: EP1,
    orgId: ORG,
    name: "orders-prod",
    paused: false,
    createdAt: "2026-05-01T00:00:00.000Z",
    dedupConfig: { mode: "content", windowSeconds: 300 },
    ingestUrl: "https://wbhk.my/whep_sealed_secret_token_value_aaaaaaaaaaaa",
  };
  it("sends the dedup config in the create body", async () => {
    const cap = capturingReq(created);
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(
      app,
      ["endpoints", "create", "orders-prod", "--dedup-mode", "content", "--dedup-window", "300"],
      t.ctx,
    );
    expect(cap.calls[0]?.method).toBe("POST");
    expect(cap.calls[0]?.body).toEqual({
      name: "orders-prod",
      dedupConfig: { mode: "content", windowSeconds: 300 },
    });
  });
  it("omits dedupConfig from the create body when no --dedup-mode is given", async () => {
    const cap = capturingReq({ ...created, dedupConfig: null });
    const t = makeTestContext({ store: loggedInStore(), fetch: cap.fetch });
    await run(app, ["endpoints", "create", "orders-prod"], t.ctx);
    expect(cap.calls[0]?.body).toEqual({ name: "orders-prod" });
  });
});
