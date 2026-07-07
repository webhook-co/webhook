import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCapProducer } from "../src/cap-producer";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The soft-cap producer: per-org, compare current-period usage to the effective cap and flip
// ingest_paused ONLY on a transition, firing edge eviction. Free (no org_limits row) uses the injected
// default cap; a row uses its own cap/policy; 'allow' never pauses; resume clears the pause.

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z → period [2026-07-01, 2026-08-01)
const IN_PERIOD = "2026-07-10T00:00:00.000Z";
const DEFAULT_CAP = 100; // injected Free default (test value; never hardcoded in source)

let pg: EphemeralPostgres;
let app: Sql;
let meter: Sql;

async function seedOrg(slug: string): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
  });
  return orgId;
}

async function seedUsage(orgId: string, count: number): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${IN_PERIOD}, ${count})`;
  });
}

async function pausedState(
  orgId: string,
): Promise<{ paused: boolean; reason: string | null } | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ paused: boolean; reason: string | null }[]>`
      select paused, reason from ingest_paused where org_id = ${orgId}`;
    return row ?? null;
  });
}

interface RunOpts {
  onTransition?: (orgId: string, paused: boolean) => Promise<void>;
  log?: (m: string, f?: Record<string, unknown>) => void;
}
async function run(opts: RunOpts = {}) {
  return runCapProducer({
    meter,
    app,
    now: NOW,
    defaultEventCap: DEFAULT_CAP,
    limit: 1000,
    onTransition: opts.onTransition,
    log: opts.log,
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  meter = createClient(pg.urlFor({ role: DB_ROLES.meter }));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await meter?.end();
  await pg?.stop();
});

describe("runCapProducer", () => {
  it("pauses a Free org (no org_limits row) once it crosses the injected default cap", async () => {
    const orgId = await seedOrg("cap-free-over");
    await seedUsage(orgId, 150); // > DEFAULT_CAP (100)
    const evicted: Array<{ orgId: string; paused: boolean }> = [];

    const result = await run({
      onTransition: async (o, p) => void evicted.push({ orgId: o, paused: p }),
    });

    expect(result.pausedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
    expect(evicted).toContainEqual({ orgId, paused: true });
  });

  it("does not pause a Free org under the default cap (no ingest_paused row created)", async () => {
    const orgId = await seedOrg("cap-free-under");
    await seedUsage(orgId, 50);
    const result = await run();
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
  });

  it("respects an explicit org_limits cap over the default", async () => {
    const orgId = await seedOrg("cap-explicit");
    await seedUsage(orgId, 500); // over the default (100) but under the org's own cap
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${1000000}, ${"pause"})`;
    });
    const result = await run();
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
  });

  it("never pauses under the 'allow' policy even over the cap", async () => {
    const orgId = await seedOrg("cap-allow");
    await seedUsage(orgId, 999);
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${100}, ${"allow"})`;
    });
    const result = await run();
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
  });

  it("resumes a paused org that is now under cap (new period / raised cap), firing eviction", async () => {
    const orgId = await seedOrg("cap-resume");
    // Pre-existing pause, but no usage this period (a fresh period) → should resume.
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into ingest_paused (org_id, paused, reason, since) values (${orgId}, ${true}, ${"cap"}, now())`;
    });
    const evicted: Array<{ orgId: string; paused: boolean }> = [];
    const result = await run({
      onTransition: async (o, p) => void evicted.push({ orgId: o, paused: p }),
    });
    expect(result.resumedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: false, reason: null });
    expect(evicted).toContainEqual({ orgId, paused: false });
  });

  it("is idempotent — no transition (or eviction) when already in the desired state", async () => {
    const orgId = await seedOrg("cap-idempotent");
    await seedUsage(orgId, 150);
    await run(); // first pass pauses
    const evicted: string[] = [];
    const result = await run({ onTransition: async (o) => void evicted.push(o) });
    expect(result.pausedTransitions).toBe(0);
    expect(result.resumedTransitions).toBe(0);
    expect(evicted).toEqual([]);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" });
  });

  it("isolates a failing eviction — the transition still commits, the pass continues", async () => {
    const orgId = await seedOrg("cap-evict-throw");
    await seedUsage(orgId, 150);
    const logs: string[] = [];
    const result = await run({
      onTransition: async () => {
        throw new Error("KV blip");
      },
      log: (m) => logs.push(m),
    });
    expect(result.pausedTransitions).toBe(1);
    expect(await pausedState(orgId)).toEqual({ paused: true, reason: "cap" }); // durable write survived
    expect(logs).toContain("metering.cap.evict_failed");
  });
});
