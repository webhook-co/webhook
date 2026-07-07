import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeCapTransitionEvictor, runCapProducer } from "../src/cap-producer";
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
let admin: Sql; // superuser (bypasses RLS) — for cross-org cleanup between tests

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
  limit?: number;
  defaultEventCap?: number | null;
}
async function run(opts: RunOpts = {}) {
  return runCapProducer({
    meter,
    app,
    now: NOW,
    defaultEventCap: opts.defaultEventCap === undefined ? DEFAULT_CAP : opts.defaultEventCap,
    limit: opts.limit ?? 1000,
    onTransition: opts.onTransition,
    log: opts.log,
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  meter = createClient(pg.urlFor({ role: DB_ROLES.meter }));
  admin = createClient(pg.ownerUrl); // the postgres superuser — bypasses RLS for cleanup
}, 90_000);

// Per-test isolation: runCapProducer enumerates ALL orgs cross-tenant, so state seeded by one test
// would otherwise perturb another's global transition counts. Clear the mutable tables before each test
// (as owner, bypassing RLS) so every test starts clean and its counters are exact. DELETE (not TRUNCATE
// CASCADE) — cascade would hit audit_log's append-only guard; child→parent order respects the FKs.
beforeEach(async () => {
  await admin`delete from events`;
  await admin`delete from usage`;
  await admin`delete from ingest_paused`;
  await admin`delete from org_limits`;
  await admin`delete from endpoints`;
  await admin`delete from orgs`;
});

afterAll(async () => {
  await app?.end();
  await meter?.end();
  await admin?.end();
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

  it("reports capped=false on a normal pass and capped=true when the enumeration hits the limit", async () => {
    // A pass under the limit is not truncated.
    const under = await run({ limit: 1000 });
    expect(under.capped).toBe(false);
    // Force truncation: two candidate orgs (org_limits rows) with limit 1 → capped, tail deferred.
    await seedOrg("cap-trunc-a").then((o) =>
      withTenant(
        app,
        o,
        (tx) => tx`insert into org_limits (org_id, event_cap) values (${o}, ${100})`,
      ),
    );
    await seedOrg("cap-trunc-b").then((o) =>
      withTenant(
        app,
        o,
        (tx) => tx`insert into org_limits (org_id, event_cap) values (${o}, ${100})`,
      ),
    );
    const capped = await run({ limit: 1 });
    expect(capped.capped).toBe(true);
    expect(capped.orgsProcessed).toBe(1);
  });

  it("does not pause a Free org under the default cap (no ingest_paused row created)", async () => {
    const orgId = await seedOrg("cap-free-under");
    await seedUsage(orgId, 50);
    const result = await run();
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
  });

  it("NEVER pauses a Free org when the default cap is null (FREE_EVENT_CAP unset/invalid = uncapped)", async () => {
    // The fail-safe: a huge-usage Free org with no injected cap must not pause. A regression here would
    // mass-pause every Free org whenever FREE_EVENT_CAP is unset — the exact outage the guard prevents.
    const orgId = await seedOrg("cap-free-uncapped");
    await seedUsage(orgId, 10_000_000); // >> any tier cap
    const evicted: string[] = [];
    const result = await run({
      defaultEventCap: null,
      onTransition: async (o) => void evicted.push(o),
    });
    expect(result.pausedTransitions).toBe(0);
    expect(await pausedState(orgId)).toBeNull();
    expect(evicted).toEqual([]); // no transition → no eviction
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

describe("makeCapTransitionEvictor (the onTransition edge-eviction fan-out)", () => {
  async function seedEndpoint(orgId: string, name: string, deleted = false): Promise<Uint8Array> {
    const hash = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""); // 64 hex chars
    const bytes = Buffer.from(hash, "hex"); // 32-byte token hash
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into endpoints (id, org_id, ingest_token_hash, name, deleted_at)
               values (${randomUUID()}, ${orgId}, ${bytes}, ${name}, ${deleted ? new Date().toISOString() : null})`;
    });
    return new Uint8Array(bytes);
  }

  it("evicts EVERY live endpoint's ingest-token hash for the org, skipping soft-deleted ones", async () => {
    const orgId = await seedOrg("evict-fanout");
    const h1 = await seedEndpoint(orgId, "ep-1");
    const h2 = await seedEndpoint(orgId, "ep-2");
    await seedEndpoint(orgId, "ep-deleted", true); // must NOT be evicted

    const evicted: string[] = [];
    const evict = async (h: Uint8Array) => void evicted.push(Buffer.from(h).toString("hex"));
    const onTransition = makeCapTransitionEvictor(app, evict);
    await onTransition(orgId);

    const hex = (h: Uint8Array) => Buffer.from(h).toString("hex");
    expect(evicted.sort()).toEqual([hex(h1), hex(h2)].sort());
    expect(evicted).toHaveLength(2); // the deleted endpoint's hash is excluded
  });

  it("is RLS-scoped — evicts only the target org's endpoints, never another org's", async () => {
    const a = await seedOrg("evict-iso-a");
    const b = await seedOrg("evict-iso-b");
    const ha = await seedEndpoint(a, "a-ep");
    await seedEndpoint(b, "b-ep");

    const evicted: string[] = [];
    await makeCapTransitionEvictor(
      app,
      async (h) => void evicted.push(Buffer.from(h).toString("hex")),
    )(a);
    expect(evicted).toEqual([Buffer.from(ha).toString("hex")]);
  });
});
