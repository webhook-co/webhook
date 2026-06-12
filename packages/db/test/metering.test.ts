import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Usage rollup (H3): events-derived, exactly-once via the dedup unique, RLS-safe and
// idempotent. No counter lives in ingest_event — usage is recomputed from events.

let pg: EphemeralPostgres;
let app: Sql;
let orgA: string;
let orgB: string;

const WINDOW = new Date("2026-06-12T00:00:00.000Z");

async function seedOrgWithEvents(slug: string, eventCount: number): Promise<string> {
  const orgId = randomUUID();
  const endpointId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep"})`;
    for (let i = 0; i < eventCount; i++) {
      await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
               values (${randomUUID()}, ${orgId}, ${endpointId}, ${"k" + i}, ${10}, ${"d" + i}, ${"content_hash"})`;
    }
  });
  return orgId;
}

async function rollup(orgId: string): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`select rollup_usage(${WINDOW.toISOString()}::timestamptz)`;
  });
}

async function usageCount(orgId: string): Promise<number> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ event_count: number }[]>`
      select event_count from usage where org_id = ${orgId} and window_start = ${WINDOW.toISOString()}::timestamptz`;
    return row ? Number(row.event_count) : 0;
  });
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  orgA = await seedOrgWithEvents("rollup-a", 3);
  orgB = await seedOrgWithEvents("rollup-b", 5);
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("rollup_usage (H3)", () => {
  it("counts exactly the org's events for the window", async () => {
    await rollup(orgA);
    await rollup(orgB);
    expect(await usageCount(orgA)).toBe(3);
    expect(await usageCount(orgB)).toBe(5);
  });

  it("is idempotent — re-running recomputes the same count", async () => {
    await rollup(orgA);
    await rollup(orgA);
    expect(await usageCount(orgA)).toBe(3);
  });

  it("does not double-count a deduped retry (no second event row)", async () => {
    const before = await usageCount(orgA);
    // A retry collides on (endpoint_id, dedup_key) -> no new row -> count unchanged.
    await withTenant(app, orgA, async (tx) => {
      const [{ id: endpointId }] = await tx<{ id: string }[]>`select id from endpoints limit 1`;
      await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
               values (${randomUUID()}, ${orgA}, ${endpointId}, ${"kdup"}, ${10}, ${"d0"}, ${"content_hash"})
               on conflict (endpoint_id, dedup_key) do nothing`;
    });
    await rollup(orgA);
    expect(await usageCount(orgA)).toBe(before);
  });

  it("a rollup run in org A's context never aggregates org B (RLS-safe)", async () => {
    await rollup(orgA);
    // org A's usage row reflects only org A's events.
    expect(await usageCount(orgA)).toBe(3);
  });
});
