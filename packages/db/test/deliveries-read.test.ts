import { randomUUID } from "node:crypto";

import { newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql, type TenantTx } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { getDelivery, listDeliveries } from "../src/reads";
import { createReplayDestination } from "../src/replay-destinations";
import { createSubscription } from "../src/subscriptions";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// deliveries.get/list db reads (S3 Slice 3 PR3a) — the auto-delivery OBSERVABILITY surface, against a REAL
// Postgres under webhook_app + RLS. Newest-first keyset browse + destination/subscription/status filters +
// cross-org isolation.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let orgA: string;
let orgB: string;
let epA: string;
let epB: string;
let destA: string;
let subA: string;

async function seedEvent(org: string, endpoint: string): Promise<string> {
  const id = newId();
  await withTenant(app, org, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, verified)
      values
        (${id}, ${org}, ${endpoint}, ${`org/${org}/ep/${endpoint}/${id}`}, ${10}, ${"application/json"},
         ${tx.json([["webhook-id", "in"]])}, ${newId()}, ${"content_hash"}, ${"stripe"}, ${true})`;
  });
  return id;
}

/** Seed a delivery_attempts row directly under a tenant tx. `createdAt` is explicit where order matters. */
async function seedDelivery(
  org: string,
  over: {
    eventId?: string;
    destinationId?: string | null;
    subscriptionId?: string | null;
    status?: string;
    statusCode?: number | null;
    attempt?: number;
    error?: string | null;
    nextRetryAt?: Date | null;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const id = newId();
  // Each org owns a distinct endpoint (the composite events FK pins endpoint↔org); default per org.
  const eventId = over.eventId ?? (await seedEvent(org, org === orgB ? epB : epA));
  await withTenant(app, org, async (tx: TenantTx) => {
    await tx`
      insert into delivery_attempts
        (id, org_id, event_id, destination_id, subscription_id, target, status, status_code, attempt,
         error, next_retry_at, created_at)
      values
        (${id}, ${org}, ${eventId}, ${over.destinationId ?? null}, ${over.subscriptionId ?? null},
         ${"auto"}, ${over.status ?? "queued"}, ${over.statusCode ?? null}, ${over.attempt ?? 1},
         ${over.error ?? null}, ${over.nextRetryAt ?? null}, ${over.createdAt ?? new Date()})`;
  });
  return id;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
  epA = (await createEndpoint(app, { orgId: orgA, name: "ep-a" }, hasher)).id;
  epB = (await createEndpoint(app, { orgId: orgB, name: "ep-b" }, hasher)).id;
  destA = (await createReplayDestination(app, { orgId: orgA, url: "https://a.example.com/in" })).id;
  subA = (
    await createSubscription(app, { orgId: orgA, sourceEndpointId: epA, destinationId: destA })
  ).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("getDelivery", () => {
  it("returns the delivery shaped for the reads surface (routing link + retry clock)", async () => {
    const eventId = await seedEvent(orgA, epA);
    const at = new Date("2026-07-01T00:00:00.000Z");
    const id = await seedDelivery(orgA, {
      eventId,
      destinationId: destA,
      subscriptionId: subA,
      status: "delivered",
      statusCode: 200,
      attempt: 2,
      nextRetryAt: null,
      createdAt: at,
    });

    const got = await withTenant(app, orgA, (tx) => getDelivery(tx, id));
    expect(got).toEqual({
      id,
      eventId,
      destinationId: destA,
      subscriptionId: subA,
      status: "delivered",
      statusCode: 200,
      attempt: 2,
      error: null,
      nextRetryAt: null,
      createdAt: at,
    });
  });

  it("returns null for an unknown id and for a cross-org id (RLS hides it — no existence oracle)", async () => {
    expect(await withTenant(app, orgA, (tx) => getDelivery(tx, newId()))).toBeNull();
    const bId = await seedDelivery(orgB); // belongs to org B
    expect(await withTenant(app, orgA, (tx) => getDelivery(tx, bId))).toBeNull();
  });
});

describe("listDeliveries", () => {
  it("browses newest-first and paginates via the keyset cursor", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-page" }, hasher)).id;
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://p.example.com/in" })
    ).id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const eventId = await seedEvent(orgA, ep);
      ids.push(
        await seedDelivery(orgA, {
          eventId,
          destinationId: dest,
          createdAt: new Date(2026, 6, 1, 0, 0, i), // ascending create time
        }),
      );
    }
    // newest-first: [id2, id1, id0]. Page size 2 → first page [id2, id1] + a cursor; second page [id0].
    const page1 = await withTenant(app, orgA, (tx) =>
      listDeliveries(tx, { destinationId: dest, limit: 2 }),
    );
    expect(page1.items.map((d) => d.id)).toEqual([ids[2], ids[1]]);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await withTenant(app, orgA, (tx) =>
      listDeliveries(tx, { destinationId: dest, limit: 2, cursor: page1.nextCursor! }),
    );
    expect(page2.items.map((d) => d.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();
  });

  it("filters by subscriptionId and by status (multi-select)", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-filter" }, hasher)).id;
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://f.example.com/in" })
    ).id;
    const sub = (
      await createSubscription(app, { orgId: orgA, sourceEndpointId: ep, destinationId: dest })
    ).id;
    const delivered = await seedDelivery(orgA, {
      destinationId: dest,
      subscriptionId: sub,
      status: "delivered",
      statusCode: 200,
    });
    const dead = await seedDelivery(orgA, {
      destinationId: dest,
      subscriptionId: sub,
      status: "dead",
    });
    await seedDelivery(orgA, { destinationId: dest, status: "queued" }); // no subscription link

    // subscription filter excludes the unlinked queued row.
    const bySub = await withTenant(app, orgA, (tx) => listDeliveries(tx, { subscriptionId: sub }));
    expect(bySub.items.map((d) => d.id).sort()).toEqual([delivered, dead].sort());

    // status multi-select: only delivered|dead of THIS destination.
    const byStatus = await withTenant(app, orgA, (tx) =>
      listDeliveries(tx, { destinationId: dest, status: ["delivered", "dead"] }),
    );
    expect(byStatus.items.map((d) => d.id).sort()).toEqual([delivered, dead].sort());
    expect(byStatus.items.every((d) => d.status === "delivered" || d.status === "dead")).toBe(true);
  });

  it("is RLS-scoped: org A never sees org B's deliveries", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://iso.example.com/in" })
    ).id;
    const mine = await seedDelivery(orgA, { destinationId: dest }); // event on epA (org A) by default
    await seedDelivery(orgB); // org B's delivery
    const page = await withTenant(app, orgA, (tx) => listDeliveries(tx, { destinationId: dest }));
    expect(page.items.map((d) => d.id)).toEqual([mine]);
  });
});
