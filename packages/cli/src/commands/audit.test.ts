import { run } from "@stricli/core";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { CredentialStore } from "../config/store.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";

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

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const okFetch = (body: unknown): typeof fetch =>
  (async () => json(body)) as unknown as typeof fetch;

const BREAK = {
  ok: false,
  rowsVerified: 2,
  break: { kind: "hash_mismatch", seq: 3, detail: "row 3 hash mismatch" },
};

describe("wbhk audit verify", () => {
  it("reports an intact chain and exits 0", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ ok: true, rowsVerified: 5 }),
    });
    await run(app, ["audit", "verify"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    expect(t.stdout()).toContain("audit chain intact");
    expect(t.stdout()).toContain("5 rows");
  });

  it("reports a break, still prints to stdout, and exits AUDIT_BREAK (3)", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(BREAK) });
    await run(app, ["audit", "verify"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.AUDIT_BREAK);
    expect(t.stdout()).toContain("BROKEN");
    expect(t.stdout()).toContain("seq 3");
  });

  it("emits the raw result as JSON in both arms", async () => {
    const ok = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ ok: true, rowsVerified: 5 }),
    });
    await run(app, ["audit", "verify", "--output", "json"], ok.ctx);
    expect(JSON.parse(ok.stdout())).toEqual({ ok: true, rowsVerified: 5 });

    const broken = makeTestContext({ store: loggedInStore(), fetch: okFetch(BREAK) });
    await run(app, ["audit", "verify", "--output", "json"], broken.ctx);
    expect(JSON.parse(broken.stdout())).toMatchObject({ ok: false, rowsVerified: 2 });
    expect(normalizeStricliExitCode(broken.ctx.process.exitCode)).toBe(EXIT.AUDIT_BREAK);
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
      },
    });
    await run(app, ["audit", "verify"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });
});
