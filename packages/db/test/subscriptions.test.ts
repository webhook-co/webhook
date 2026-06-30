import { randomUUID } from "node:crypto";

import { CapabilityFault, type AuthContext } from "@webhook-co/contract";
import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { createOrg } from "../src/orgs";
import { createReplayDestination, softDeleteReplayDestination } from "../src/replay-destinations";
import {
  createSubscription,
  createSubscriptionHandlers,
  deleteSubscription,
  listMatchingSubscriptions,
  listSubscriptions,
  SubscriptionTargetNotFoundError,
  type MatchableEvent,
} from "../src/subscriptions";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// delivery_subscriptions CRUD + the per-endpoint ingest resolver (S3 Slice 3 PR2a), against a REAL Postgres
// under the webhook_app role + RLS. The pure matcher itself is covered in subscriptions-match.test.ts.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });

let pg: EphemeralPostgres;
let app: Sql;
let orgA: string;
let epA: string;
let destA: string;

const ev = (over: Partial<MatchableEvent> = {}): MatchableEvent => ({
  provider: over.provider ?? "stripe",
  eventType: over.eventType === undefined ? "charge.succeeded" : over.eventType,
  verified: over.verified ?? true,
});

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  orgA = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org A" })).id;
  epA = (await createEndpoint(app, { orgId: orgA, name: "ep-a" }, hasher)).id;
  destA = (await createReplayDestination(app, { orgId: orgA, url: "https://a.example.com/in" })).id;
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("createSubscription", () => {
  it("inserts with the zero-config defaults (provider null, ['*'], requireVerified false, enabled true)", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://c1.example.com/in" })
    ).id;
    const sub = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
    });
    expect(sub).toMatchObject({
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
      provider: null,
      eventTypes: ["*"],
      requireVerified: false,
      enabled: true,
    });
    expect(sub.id).toBeTruthy();
  });

  it("stores explicit selectors", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://c2.example.com/in" })
    ).id;
    const sub = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
      provider: "stripe",
      eventTypes: ["charge.*", "invoice.paid"],
      requireVerified: true,
    });
    expect(sub).toMatchObject({
      provider: "stripe",
      eventTypes: ["charge.*", "invoice.paid"],
      requireVerified: true,
    });
  });

  it("UPSERTS on (org, source endpoint, destination): a re-create updates selectors, no duplicate", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://c3.example.com/in" })
    ).id;
    const first = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
    });
    const second = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
      provider: "github",
      eventTypes: ["push"],
    });
    expect(second.id).toBe(first.id); // same row
    expect(second.provider).toBe("github");
    expect(second.eventTypes).toEqual(["push"]);
    const all = await listSubscriptions(app, orgA, epA);
    expect(all.filter((s) => s.destinationId === dest)).toHaveLength(1); // no duplicate
  });

  it("an empty event_types defaults to ['*'] (match-all), never the degenerate match-nothing", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://ce.example.com/in" })
    ).id;
    const sub = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
      eventTypes: [],
    });
    expect(sub.eventTypes).toEqual(["*"]);
  });

  it("an UPDATE preserves a paused subscription's enabled=false (editing selectors must not un-pause)", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://cp.example.com/in" })
    ).id;
    const sub = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
    });
    await withTenant(
      app,
      orgA,
      (tx) => tx`update delivery_subscriptions set enabled = false where id = ${sub.id}`,
    );
    const updated = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
      eventTypes: ["charge.*"],
    });
    expect(updated.id).toBe(sub.id);
    expect(updated.eventTypes).toEqual(["charge.*"]); // selectors updated
    expect(updated.enabled).toBe(false); // but the pause is NOT clobbered
  });

  it("throws SubscriptionTargetNotFoundError for a soft-deleted destination, a deleted source endpoint, or a cross-org target", async () => {
    // soft-deleted destination
    const dead = (
      await createReplayDestination(app, { orgId: orgA, url: "https://cd.example.com/in" })
    ).id;
    await softDeleteReplayDestination(app, orgA, dead);
    await expect(
      createSubscription(app, { orgId: orgA, sourceEndpointId: epA, destinationId: dead }),
    ).rejects.toBeInstanceOf(SubscriptionTargetNotFoundError);

    // soft-deleted source endpoint
    const deadEp = (await createEndpoint(app, { orgId: orgA, name: "ep-dead" }, hasher)).id;
    await withTenant(
      app,
      orgA,
      (tx) => tx`update endpoints set deleted_at = now() where id = ${deadEp}`,
    );
    const liveDest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://cl.example.com/in" })
    ).id;
    await expect(
      createSubscription(app, { orgId: orgA, sourceEndpointId: deadEp, destinationId: liveDest }),
    ).rejects.toBeInstanceOf(SubscriptionTargetNotFoundError);

    // cross-org: org A can't bind to org B's destination (RLS hides it → resolves as not-found → throws)
    const orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org Bx" })).id;
    const destB = (
      await createReplayDestination(app, { orgId: orgB, url: "https://cb.example.com/in" })
    ).id;
    await expect(
      createSubscription(app, { orgId: orgA, sourceEndpointId: epA, destinationId: destB }),
    ).rejects.toBeInstanceOf(SubscriptionTargetNotFoundError);
  });
});

describe("listSubscriptions", () => {
  it("lists the org's subscriptions (optionally filtered by source endpoint), newest first; RLS-isolated", async () => {
    const ep2 = (await createEndpoint(app, { orgId: orgA, name: "ep-2" }, hasher)).id;
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://l1.example.com/in" })
    ).id;
    const s = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: ep2,
      destinationId: dest,
    });
    const forEp2 = await listSubscriptions(app, orgA, ep2);
    expect(forEp2.map((x) => x.id)).toEqual([s.id]);
    expect((await listSubscriptions(app, orgA)).map((x) => x.id)).toContain(s.id);

    // a SECOND org can't see org A's subscriptions
    const orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B" })).id;
    expect(await listSubscriptions(app, orgB)).toHaveLength(0);
  });
});

describe("deleteSubscription", () => {
  it("hard-deletes; a second delete and a cross-org delete both return null", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://d1.example.com/in" })
    ).id;
    const sub = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
    });
    expect(await deleteSubscription(app, orgA, sub.id)).toEqual({ id: sub.id });
    expect(await deleteSubscription(app, orgA, sub.id)).toBeNull(); // already gone
    const orgB = (await createOrg(app, { slug: randomUUID().slice(0, 8), name: "Org B2" })).id;
    const sub2 = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: destA,
    });
    expect(await deleteSubscription(app, orgB, sub2.id)).toBeNull(); // cross-org can't delete
  });

  it("deleting a subscription with a LINKED delivery unlinks it (subscription_id→null), never aborts on the NOT NULL org_id", async () => {
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://fk.example.com/in" })
    ).id;
    const sub = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: epA,
      destinationId: dest,
    });
    // seed an event + a delivery_attempts row LINKED to the subscription (PR2c-2's ingest will do this).
    const eventId = randomUUID();
    const deliveryId = randomUUID();
    await withTenant(app, orgA, async (tx) => {
      await tx`
        insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, content_type, headers,
          dedup_key, dedup_strategy, provider, verified)
        values (${eventId}, ${orgA}, ${epA}, ${`org/${orgA}/ep/${epA}/${eventId}`}, ${10},
          ${"application/json"}, ${tx.json([])}, ${randomUUID()}, ${"content_hash"}, ${"stripe"}, ${true})`;
      await tx`
        insert into delivery_attempts (id, org_id, event_id, destination_id, subscription_id, target, status, attempt)
        values (${deliveryId}, ${orgA}, ${eventId}, ${dest}, ${sub.id}, ${"auto"}, ${"queued"}, ${1})`;
    });
    // the delete must SUCCEED (a bare composite SET NULL would have nulled org_id and aborted here).
    expect(await deleteSubscription(app, orgA, sub.id)).toEqual({ id: sub.id });
    // the delivery survives, unlinked: subscription_id null, org_id intact.
    const [row] = await withTenant(
      app,
      orgA,
      (tx) => tx<{ subscription_id: string | null; org_id: string }[]>`
        select subscription_id, org_id from delivery_attempts where id = ${deliveryId}`,
    );
    expect(row!.subscription_id).toBeNull();
    expect(row!.org_id).toBe(orgA);
  });
});

describe("listMatchingSubscriptions (the ingest resolver)", () => {
  it("returns the endpoint's enabled subscriptions whose selectors match the event, excluding dead destinations", async () => {
    const ep = (await createEndpoint(app, { orgId: orgA, name: "ep-match" }, hasher)).id;
    const dStripe = (
      await createReplayDestination(app, { orgId: orgA, url: "https://m-stripe.example.com/in" })
    ).id;
    const dGithub = (
      await createReplayDestination(app, { orgId: orgA, url: "https://m-github.example.com/in" })
    ).id;
    const dDisabledSub = (
      await createReplayDestination(app, { orgId: orgA, url: "https://m-dis.example.com/in" })
    ).id;
    const dDeadDest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://m-dead.example.com/in" })
    ).id;

    const matchStripe = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: ep,
      destinationId: dStripe,
      provider: "stripe",
      eventTypes: ["charge.*"],
    });
    await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: ep,
      destinationId: dGithub,
      provider: "github", // wrong provider — should NOT match a stripe event
    });
    const disabled = await createSubscription(app, {
      orgId: orgA,
      sourceEndpointId: ep,
      destinationId: dDisabledSub,
    });
    await withTenant(
      app,
      orgA,
      (tx) => tx`update delivery_subscriptions set enabled = false where id = ${disabled.id}`,
    );
    await createSubscription(app, { orgId: orgA, sourceEndpointId: ep, destinationId: dDeadDest });
    await softDeleteReplayDestination(app, orgA, dDeadDest); // destination removed → not a delivery target

    const matches = await withTenant(app, orgA, (tx) =>
      listMatchingSubscriptions(tx, {
        orgId: orgA,
        sourceEndpointId: ep,
        event: ev({ provider: "stripe", eventType: "charge.succeeded" }),
      }),
    );
    // only the enabled, provider+type-matching subscription to a LIVE destination
    expect(matches.map((m) => m.id)).toEqual([matchStripe.id]);
    expect(matches[0]!.destinationId).toBe(dStripe);
  });
});

describe("audit", () => {
  it("writes delivery_subscription.created / .removed audit rows when an audit key is supplied", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(9));
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://au.example.com/in" })
    ).id;
    const sub = await createSubscription(
      app,
      { orgId: orgA, sourceEndpointId: epA, destinationId: dest },
      { auditKey, actor: null },
    );
    await deleteSubscription(app, orgA, sub.id, { auditKey, actor: null });
    const rows = await withTenant(
      app,
      orgA,
      (tx) => tx<{ action: string }[]>`
        select action from audit_log where org_id = ${orgA} and target = ${sub.id} order by action`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      "delivery_subscription.created",
      "delivery_subscription.removed",
    ]);
  });

  it("a re-create (upsert that updates) records delivery_subscription.updated, not a second .created", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(9));
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://au2.example.com/in" })
    ).id;
    const sub = await createSubscription(
      app,
      { orgId: orgA, sourceEndpointId: epA, destinationId: dest },
      { auditKey, actor: null },
    );
    await createSubscription(
      app,
      { orgId: orgA, sourceEndpointId: epA, destinationId: dest, eventTypes: ["charge.*"] },
      { auditKey, actor: null },
    );
    const rows = await withTenant(
      app,
      orgA,
      (tx) => tx<{ action: string }[]>`
        select action from audit_log where org_id = ${orgA} and target = ${sub.id} order by created_at`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      "delivery_subscription.created", // first create
      "delivery_subscription.updated", // the re-create updated the existing row
    ]);
  });
});

describe("createSubscriptionHandlers (capability handlers)", () => {
  const ctx = (scopes: string[]): AuthContext => ({ orgId: orgA, scopes });
  const handlers = () => createSubscriptionHandlers({ tenant: app, auditKey: undefined as never });

  it("enforces the capability scope (FORBIDDEN without endpoints:write / endpoints:read)", async () => {
    const create = handlers().get("subscriptions.create")!;
    await expect(
      create(ctx(["endpoints:read"]), { sourceEndpointId: epA, destinationId: destA }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const list = handlers().get("subscriptions.list")!;
    await expect(list(ctx([]), {})).rejects.toBeInstanceOf(CapabilityFault);
  });

  it("create returns the subscription; a dead/cross-org target → NOT_FOUND", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(3));
    const h = createSubscriptionHandlers({ tenant: app, auditKey });
    const dest = (
      await createReplayDestination(app, { orgId: orgA, url: "https://h1.example.com/in" })
    ).id;
    const out = (await h.get("subscriptions.create")!(ctx(["endpoints:write"]), {
      sourceEndpointId: epA,
      destinationId: dest,
      eventTypes: ["charge.*"],
    })) as { id: string; eventTypes: string[] };
    expect(out.id).toBeTruthy();
    expect(out.eventTypes).toEqual(["charge.*"]);

    // a destination that doesn't exist → NOT_FOUND (not a 500)
    await expect(
      h.get("subscriptions.create")!(ctx(["endpoints:write"]), {
        sourceEndpointId: epA,
        destinationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("delete of an unknown id → NOT_FOUND", async () => {
    const auditKey = await importAuditKey(new Uint8Array(32).fill(3));
    const h = createSubscriptionHandlers({ tenant: app, auditKey });
    await expect(
      h.get("subscriptions.delete")!(ctx(["endpoints:write"]), { subscriptionId: randomUUID() }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
