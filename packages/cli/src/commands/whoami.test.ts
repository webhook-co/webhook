import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { StoredCredential } from "../config/schema.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

function memStore(initial: StoredCredential | null = null): CredentialStore {
  let cred = initial;
  return {
    get: async () => cred,
    set: async (c) => void (cred = c),
    erase: async () => void (cred = null),
    list: async () => (cred ? ["default"] : []),
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
    });
  });
});
