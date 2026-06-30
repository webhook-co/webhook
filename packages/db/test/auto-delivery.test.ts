import { randomUUID } from "node:crypto";

import { newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { insertQueuedDelivery, listDueDeliveries } from "../src/delivery";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createReplayDestination, softDeleteReplayDestination } from "../src/replay-destinations";
import { createSubscription, enqueueAutoDeliveries } from "../src/subscriptions";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// S3 Slice 3 PR2c — native auto-delivery wiring. After a genuinely-new event is durable, the ingest worker
// resolves the source endpoint's matching subscriptions and durably enqueues a `queued` delivery_attempts
// row per match, then wakes each destination's DO. These db helpers are the durable half; exercised against
// a REAL Postgres under webhook_app + RLS (the engine's HYPERDRIVE_TENANT role).

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let orgId: string;

/** Seed an event under the org for a given endpoint (reuses the delivery-test column-list shape). A
 *  null provider models an unrecognized sender. */
async function seedEvent(
  forEndpoint: string,
  opts: { provider?: string | null; verified?: boolean } = {},
): Promise<string> {
  const id = newId();
  const provider = "provider" in opts ? opts.provider : "stripe";
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into events
        (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
         dedup_key, dedup_strategy, provider, verified)
      values
        (${id}, ${orgId}, ${forEndpoint}, ${`org/${orgId}/ep/${forEndpoint}/${id}`}, ${10},
         ${"application/json"}, ${tx.json([["webhook-id", "in_1"]])}, ${newId()}, ${"content_hash"},
         ${provider ?? null}, ${opts.verified ?? true})`;
  });
  return id;
}

/** A fresh source endpoint per test so subscriptions never bleed across cases (an endpoint can carry many
 *  subscriptions, and enqueueAutoDeliveries correctly resolves ALL of them). */
const freshEndpoint = (name: string) =>
  createEndpoint(app, { orgId, name }, hasher).then((e) => e.id);

const openDeliveries = (destinationId: string) =>
  withTenant(
    app,
    orgId,
    (tx) => tx<{ id: string; event_id: string; subscription_id: string | null; status: string }[]>`
      select id, event_id, subscription_id, status from delivery_attempts
      where destination_id = ${destinationId} order by created_at asc, id asc`,
  );

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  orgId = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("insertQueuedDelivery", () => {
  it("inserts an immediately-due queued row linked to event+destination+subscription, surfaced to the DO drain", async () => {
    const ep = await freshEndpoint("ep-iqd");
    const dest = (await createReplayDestination(app, { orgId, url: "https://q1.example.com/in" }))
      .id;
    const sub = await createSubscription(app, { orgId, sourceEndpointId: ep, destinationId: dest });
    const eventId = await seedEvent(ep);

    const deliveryId = await withTenant(app, orgId, (tx) =>
      insertQueuedDelivery(tx, { orgId, eventId, destinationId: dest, subscriptionId: sub.id }),
    );
    expect(deliveryId).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await openDeliveries(dest);
    expect(row).toMatchObject({
      id: deliveryId,
      event_id: eventId,
      subscription_id: sub.id,
      status: "queued",
    });

    // next_retry_at = now() so the destination's DO drain query (queued + due) surfaces it on its next alarm.
    const due = await withTenant(app, orgId, (tx) => listDueDeliveries(tx, dest, 50));
    expect(due.map((d) => d.id)).toContain(deliveryId);
    expect(due.find((d) => d.id === deliveryId)?.attempt).toBe(1);
  });
});

describe("enqueueAutoDeliveries", () => {
  it("enqueues one queued delivery per matching subscription and returns the distinct destination ids", async () => {
    const ep = await freshEndpoint("ep-match");
    const dest = (await createReplayDestination(app, { orgId, url: "https://m1.example.com/in" }))
      .id;
    await createSubscription(app, {
      orgId,
      sourceEndpointId: ep,
      destinationId: dest,
      provider: "stripe",
      eventTypes: ["charge.*"],
    });
    const eventId = await seedEvent(ep);

    const destinationIds = await enqueueAutoDeliveries(app, {
      orgId,
      sourceEndpointId: ep,
      event: { eventId, provider: "stripe", eventType: "charge.succeeded", verified: true },
    });
    expect(destinationIds).toEqual([dest]);

    const rows = await openDeliveries(dest);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: eventId, status: "queued" });
  });

  it("returns no destinations when nothing matches (provider mismatch ⇒ no delivery enqueued)", async () => {
    const ep = await freshEndpoint("ep-mismatch");
    const dest = (await createReplayDestination(app, { orgId, url: "https://m2.example.com/in" }))
      .id;
    await createSubscription(app, {
      orgId,
      sourceEndpointId: ep,
      destinationId: dest,
      provider: "github", // event is stripe → no match
    });
    const eventId = await seedEvent(ep);

    const destinationIds = await enqueueAutoDeliveries(app, {
      orgId,
      sourceEndpointId: ep,
      event: { eventId, provider: "stripe", eventType: "charge.succeeded", verified: true },
    });
    expect(destinationIds).toEqual([]);
    expect(await openDeliveries(dest)).toHaveLength(0);
  });

  it("withholds delivery from a require_verified subscription when the event is unverified", async () => {
    const ep = await freshEndpoint("ep-verif");
    const dest = (await createReplayDestination(app, { orgId, url: "https://m3.example.com/in" }))
      .id;
    await createSubscription(app, {
      orgId,
      sourceEndpointId: ep,
      destinationId: dest,
      requireVerified: true,
    });
    const eventId = await seedEvent(ep, { verified: false });

    const unverified = await enqueueAutoDeliveries(app, {
      orgId,
      sourceEndpointId: ep,
      event: { eventId, provider: "stripe", eventType: "x", verified: false },
    });
    expect(unverified).toEqual([]); // require_verified gates the unverified event out
    expect(await openDeliveries(dest)).toHaveLength(0);
  });

  it("fans out across multiple matching destinations (one queued delivery + one wake target each)", async () => {
    const ep = await freshEndpoint("ep-fan");
    const d1 = (await createReplayDestination(app, { orgId, url: "https://f1.example.com/in" })).id;
    const d2 = (await createReplayDestination(app, { orgId, url: "https://f2.example.com/in" })).id;
    await createSubscription(app, { orgId, sourceEndpointId: ep, destinationId: d1 });
    await createSubscription(app, { orgId, sourceEndpointId: ep, destinationId: d2 });
    const eventId = await seedEvent(ep);

    const destinationIds = await enqueueAutoDeliveries(app, {
      orgId,
      sourceEndpointId: ep,
      event: { eventId, provider: "stripe", eventType: "any.thing", verified: true },
    });
    expect(destinationIds.sort()).toEqual([d1, d2].sort());
    expect(await openDeliveries(d1)).toHaveLength(1);
    expect(await openDeliveries(d2)).toHaveLength(1);
  });

  it("excludes a subscription whose destination is soft-deleted (no dead-target delivery)", async () => {
    const ep = await freshEndpoint("ep-dead");
    const dest = (await createReplayDestination(app, { orgId, url: "https://dead.example.com/in" }))
      .id;
    await createSubscription(app, { orgId, sourceEndpointId: ep, destinationId: dest });
    await softDeleteReplayDestination(app, orgId, dest);
    const eventId = await seedEvent(ep);

    const destinationIds = await enqueueAutoDeliveries(app, {
      orgId,
      sourceEndpointId: ep,
      event: { eventId, provider: "stripe", eventType: "x", verified: true },
    });
    expect(destinationIds).toEqual([]);
  });

  it("a null-provider event matches only match-any (provider null) subscriptions", async () => {
    const ep = await freshEndpoint("ep-null");
    const anyDest = (
      await createReplayDestination(app, { orgId, url: "https://any.example.com/in" })
    ).id;
    const stripeDest = (
      await createReplayDestination(app, { orgId, url: "https://str.example.com/in" })
    ).id;
    await createSubscription(app, { orgId, sourceEndpointId: ep, destinationId: anyDest }); // provider null
    await createSubscription(app, {
      orgId,
      sourceEndpointId: ep,
      destinationId: stripeDest,
      provider: "stripe",
    });
    const eventId = await seedEvent(ep, { provider: null, verified: false });

    const destinationIds = await enqueueAutoDeliveries(app, {
      orgId,
      sourceEndpointId: ep,
      event: { eventId, provider: null, eventType: null, verified: false },
    });
    expect(destinationIds).toEqual([anyDest]); // the stripe-pinned sub does not match a null provider
  });
});
