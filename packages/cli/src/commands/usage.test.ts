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

const CAPPED = {
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-08-01T00:00:00.000Z",
  events: 12345,
  eventCap: 500000,
  pausePolicy: "pause",
  paused: false,
};

describe("wbhk usage", () => {
  it("renders usage vs the included cap with a percentage + state", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(CAPPED) });
    await run(app, ["usage"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.SUCCESS);
    const out = t.stdout();
    expect(out).toContain("12,345 of 500,000 events (2%)");
    expect(out).toContain("pauses at cap");
    expect(out).toContain("active");
  });

  it("shows an uncapped org without a percentage", async () => {
    const t = makeTestContext({
      store: loggedInStore(),
      fetch: okFetch({ ...CAPPED, eventCap: null, paused: true }),
    });
    await run(app, ["usage"], t.ctx);
    const out = t.stdout();
    expect(out).toContain("12,345 events");
    expect(out).toContain("uncapped");
    expect(out).toContain("paused");
  });

  it("emits the raw UsageSummary as JSON", async () => {
    const t = makeTestContext({ store: loggedInStore(), fetch: okFetch(CAPPED) });
    await run(app, ["usage", "--output", "json"], t.ctx);
    expect(JSON.parse(t.stdout())).toMatchObject({
      events: 12345,
      eventCap: 500000,
      pausePolicy: "pause",
      paused: false,
    });
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
    await run(app, ["usage"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });
});
