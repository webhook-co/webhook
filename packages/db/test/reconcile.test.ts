import { randomUUID } from "node:crypto";

import { newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createReplayDestination } from "../src/replay-destinations";
import { listDestinationsWithDueDeliveries } from "../src/reconcile";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The delivery reconciler (S3 Slice 3 PR3c-2a): the engine's hourly cron re-wakes destinations whose
// per-destination DO went idle while a due delivery sits unclaimed (a lost wake, or a just-re-enabled
// destination). `listDestinationsWithDueDeliveries` is the cross-org READ that finds them — run on a
// webhook_reconciler connection (NOBYPASSRLS + role-targeted SELECT policies), NOT a tenant tx. Against a
// REAL Postgres + RLS, proving the cross-org read works and the liveness/due filters hold.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });
let pg: EphemeralPostgres;
let app: Sql;
let reconciler: Sql;
let orgA: string;
let orgB: string;
let epA: string;
let epB: string;

// next_retry_at relative to the reconciler's staleness grace (DUE_GRACE_SECONDS = 120):
//   "stale"  — well in the past (beyond the grace) → SURFACED (genuinely stranded)
//   "fresh"  — just now (inside the grace) → NOT surfaced (the inline wake is still handling it)
//   "future" — a scheduled retry → NOT surfaced (its DO already holds an alarm)
//   null     — no scheduled time → SURFACED (treated as immediately eligible)
type DueKind = "stale" | "fresh" | "future" | null;

/** Seed an event, then a delivery_attempts row with the given status + next_retry_at posture. */
async function seedDelivery(
  orgId: string,
  endpointId: string,
  destinationId: string,
  status: string,
  nextRetryAt: DueKind,
): Promise<string> {
  const eventId = newId();
  const id = newId();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, verified)
      values
        (${eventId}, ${orgId}, ${endpointId}, ${`k/${eventId}`}, ${10}, ${"application/json"},
         ${tx.json([["h", "v"]])}, ${newId()}, ${"content_hash"}, ${"stripe"}, ${true})`;
    const retry =
      nextRetryAt === null
        ? tx`null`
        : nextRetryAt === "stale"
          ? tx`now() - interval '10 minutes'`
          : nextRetryAt === "fresh"
            ? tx`now()`
            : tx`now() + interval '1 hour'`;
    await tx`
      insert into delivery_attempts (id, org_id, event_id, destination_id, target, status, next_retry_at)
      values (${id}, ${orgId}, ${eventId}, ${destinationId}, ${"auto"}, ${status}, ${retry})`;
  });
  return id;
}

async function newDestination(orgId: string, host: string): Promise<string> {
  return (await createReplayDestination(app, { orgId, url: `https://${host}.example.com/in` })).id;
}

const disable = (destinationId: string) =>
  withTenant(
    app,
    orgA,
    (tx) => tx`update replay_destinations set disabled_at = now() where id = ${destinationId}`,
  );
const softDelete = (destinationId: string) =>
  withTenant(
    app,
    orgA,
    (tx) => tx`update replay_destinations set deleted_at = now() where id = ${destinationId}`,
  );

/** The set of destination ids the reconciler would wake for a given org. */
async function dueDestinations(orgId: string): Promise<Set<string>> {
  const rows = await listDestinationsWithDueDeliveries(reconciler);
  return new Set(rows.filter((r) => r.orgId === orgId).map((r) => r.destinationId));
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  reconciler = createClient(pg.urlFor({ role: DB_ROLES.reconciler }));
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "B" })).id;
  epA = (await createEndpoint(app, { orgId: orgA, name: "epA" }, hasher)).id;
  epB = (await createEndpoint(app, { orgId: orgB, name: "epB" }, hasher)).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await reconciler?.end();
  await pg?.stop();
});

describe("listDestinationsWithDueDeliveries", () => {
  it("surfaces a destination with a stale queued delivery (stranded past the grace)", async () => {
    const dest = await newDestination(orgA, "queued-due");
    await seedDelivery(orgA, epA, dest, "queued", "stale");
    expect(await dueDestinations(orgA)).toContain(dest);
  });

  it("surfaces a destination whose pending retry is overdue past the grace", async () => {
    const dest = await newDestination(orgA, "pending-due");
    await seedDelivery(orgA, epA, dest, "pending", "stale");
    expect(await dueDestinations(orgA)).toContain(dest);
  });

  it("surfaces a destination with a null-next_retry_at open delivery (immediately eligible)", async () => {
    const dest = await newDestination(orgA, "null-retry");
    await seedDelivery(orgA, epA, dest, "queued", null);
    expect(await dueDestinations(orgA)).toContain(dest);
  });

  it("excludes a FRESH delivery still inside the grace (the inline wake is handling it)", async () => {
    // A just-queued delivery is being drained by the DO the ingest path woke; re-waking it every hour is
    // wasteful, so the grace keeps the reconciler's set to genuinely-stranded work only.
    const dest = await newDestination(orgA, "fresh");
    await seedDelivery(orgA, epA, dest, "queued", "fresh");
    expect(await dueDestinations(orgA)).not.toContain(dest);
  });

  it("excludes a destination whose only open delivery is scheduled for the FUTURE", async () => {
    const dest = await newDestination(orgA, "pending-future");
    await seedDelivery(orgA, epA, dest, "pending", "future");
    expect(await dueDestinations(orgA)).not.toContain(dest);
  });

  it("excludes a DISABLED destination even with a stale queued delivery", async () => {
    const dest = await newDestination(orgA, "disabled");
    await seedDelivery(orgA, epA, dest, "queued", "stale");
    await disable(dest);
    expect(await dueDestinations(orgA)).not.toContain(dest);
  });

  it("excludes a SOFT-DELETED destination even with a stale queued delivery", async () => {
    const dest = await newDestination(orgA, "deleted");
    await seedDelivery(orgA, epA, dest, "queued", "stale");
    await softDelete(dest);
    expect(await dueDestinations(orgA)).not.toContain(dest);
  });

  it("excludes a destination whose deliveries are all terminal", async () => {
    const dest = await newDestination(orgA, "terminal");
    for (const status of ["delivered", "dead", "cancelled", "blocked", "failed"]) {
      await seedDelivery(orgA, epA, dest, status, "stale");
    }
    expect(await dueDestinations(orgA)).not.toContain(dest);
  });

  it("returns each due destination exactly once (distinct) despite many due deliveries", async () => {
    const dest = await newDestination(orgA, "multi");
    await seedDelivery(orgA, epA, dest, "queued", "stale");
    await seedDelivery(orgA, epA, dest, "queued", "stale");
    await seedDelivery(orgA, epA, dest, "pending", "stale");
    const rows = await listDestinationsWithDueDeliveries(reconciler);
    expect(rows.filter((r) => r.destinationId === dest)).toHaveLength(1);
  });

  it("never returns more than the limit (bounded fan-out; fair random ordering across passes)", async () => {
    // Seed 4 fresh stranded destinations, then assert a limit of 2 truncates. Random ordering (not a fixed
    // sort) means repeated passes cover different subsets, so no destination is permanently starved.
    for (let i = 0; i < 4; i++) {
      const d = await newDestination(orgB, `capped-${i}`);
      await seedDelivery(orgB, epB, d, "queued", "stale");
    }
    const rows = await listDestinationsWithDueDeliveries(reconciler, 2);
    expect(rows.length).toBe(2);
  });

  it("reads across tenants from a context-less reconciler connection (no app.current_org)", async () => {
    const destA = await newDestination(orgA, "xorg-a");
    const destB = await newDestination(orgB, "xorg-b");
    await seedDelivery(orgA, epA, destA, "queued", "stale");
    await seedDelivery(orgB, epB, destB, "queued", "stale");
    const rows = await listDestinationsWithDueDeliveries(reconciler, 500);
    const ids = new Set(rows.map((r) => r.destinationId));
    expect(ids).toContain(destA);
    expect(ids).toContain(destB);
    // and the org_id travels with each destination
    expect(rows.find((r) => r.destinationId === destA)?.orgId).toBe(orgA);
    expect(rows.find((r) => r.destinationId === destB)?.orgId).toBe(orgB);
  });
});
