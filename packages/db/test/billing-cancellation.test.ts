import { randomUUID } from "node:crypto";

import { importAuditKey, StripeError, userActor } from "@webhook-co/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { drainBillingCancellations, type StripeCanceller } from "../src/billing-cancellation";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { deleteOrgWithAudit, requestOrgDeletion } from "../src/org-lifecycle";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Drives PR 1 end to end against a real Postgres: deleteOrgWithAudit ENQUEUES a Stripe-cancellation
// job (capturing the live subscription before the delete cascades billing_subscriptions away), and
// drainBillingCancellations cancels it against a fake Stripe — including the idempotent retry paths a
// crash can produce (resource_missing = already gone; transient error = stay pending; attempts
// exhausted = failed).

let pg: EphemeralPostgres;
let app: Sql;
let billing: Sql;
let admin: Sql;
let key: CryptoKey;

async function seedOrg(): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${"o-" + orgId.slice(0, 8)}, ${"o"})`;
  });
  return orgId;
}

/** Attach a Stripe subscription row to an org (admin bypasses RLS). Status defaults to a LIVE one. */
async function seedSubscription(orgId: string, status = "active"): Promise<string> {
  const subId = "sub_" + orgId.slice(0, 8);
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, current_period_start, current_period_end)
    values (${orgId}, ${subId}, ${"price_pro"}, ${status},
            ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`;
  return subId;
}

async function readJob(orgId: string) {
  const [row] = await admin<
    {
      stripe_subscription_id: string;
      status: string;
      attempts: number;
      canceled_at: string | null;
    }[]
  >`select stripe_subscription_id, status, attempts, canceled_at
    from org_billing_cancellations where org_id = ${orgId}`;
  return row;
}

/** A fake Stripe canceller recording the ids it was asked to cancel, with a pluggable behavior. */
function fakeCanceller(
  behavior: (id: string) => void = () => {},
): StripeCanceller & { ids: string[] } {
  const ids: string[] = [];
  return {
    ids,
    async cancelSubscription(id: string) {
      ids.push(id);
      behavior(id);
      return { id, status: "canceled" };
    },
  };
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  billing = createClient(pg.urlFor({ role: DB_ROLES.billing }));
  admin = createClient(pg.providerUrl);
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 5) % 256)));
}, setupHookTimeoutMs());

afterEach(async () => {
  await admin`delete from org_billing_cancellations`;
  await admin`delete from billing_subscriptions`;
  await admin`delete from orgs`;
});

// Stop the ephemeral cluster and close every client. On CI's SHARED Postgres service this is
// load-bearing, not tidiness: a database left alive keeps its webhook_* role grants in pg_shdepend,
// which pins those cluster-global roles and makes migrations.test.ts's down-all `DROP ROLE` fail with
// "role cannot be dropped because some objects depend on it". Every file that starts a cluster must stop it.
afterAll(async () => {
  await app?.end();
  await billing?.end();
  await admin?.end();
  await pg?.stop();
});

describe("deleteOrgWithAudit enqueues a Stripe cancellation", () => {
  it("enqueues the live subscription id when a paid org is deleted", async () => {
    const orgId = await seedOrg();
    const subId = await seedSubscription(orgId, "active");

    await deleteOrgWithAudit(app, { orgId, actor: userActor("u1") }, key);

    const job = await readJob(orgId);
    expect(job).toMatchObject({ stripe_subscription_id: subId, status: "pending", attempts: 0 });
  });

  it("does NOT enqueue for a Free org with no subscription", async () => {
    const orgId = await seedOrg();
    await deleteOrgWithAudit(app, { orgId, actor: userActor("u1") }, key);
    expect(await readJob(orgId)).toBeUndefined();
  });

  it("does NOT enqueue for an already-canceled subscription (nothing to cancel)", async () => {
    const orgId = await seedOrg();
    await seedSubscription(orgId, "canceled");
    await deleteOrgWithAudit(app, { orgId, actor: userActor("u1") }, key);
    expect(await readJob(orgId)).toBeUndefined();
  });
});

// The async requestOrgDeletion (#665) shares enqueueOrgDeletionSideEffects, so it must capture the same
// cancellation BEFORE the reaper later cascades the subscription away — otherwise a paying customer who
// deletes keeps being charged for the whole reaper window.
describe("requestOrgDeletion enqueues the same Stripe cancellation (#665)", () => {
  it("enqueues the live subscription id for a paid org", async () => {
    const orgId = await seedOrg();
    const subId = await seedSubscription(orgId, "active");
    await requestOrgDeletion(app, { orgId, actor: userActor("u1") }, key);
    expect(await readJob(orgId)).toMatchObject({
      stripe_subscription_id: subId,
      status: "pending",
    });
  });

  it("does NOT enqueue for a Free org, and a re-request stays idempotent (one job)", async () => {
    const free = await seedOrg();
    await requestOrgDeletion(app, { orgId: free, actor: userActor("u1") }, key);
    expect(await readJob(free)).toBeUndefined();

    const paid = await seedOrg();
    await seedSubscription(paid, "active");
    await requestOrgDeletion(app, { orgId: paid, actor: userActor("u1") }, key);
    await requestOrgDeletion(app, { orgId: paid, actor: userActor("u1") }, key); // idempotent re-request
    const [row] = await withTenant(
      app,
      paid,
      (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from org_billing_cancellations where org_id = ${paid}`,
    );
    expect(row!.n).toBe(1);
  });
});

describe("drainBillingCancellations", () => {
  // A pending job can exist for an org that is already gone (the real case), so no org row is needed —
  // insert the outbox row directly (admin bypasses RLS).
  async function enqueue(orgId: string, subId: string): Promise<void> {
    await admin`
      insert into org_billing_cancellations (org_id, stripe_subscription_id)
      values (${orgId}, ${subId})`;
  }

  it("cancels a pending subscription at Stripe and marks it canceled", async () => {
    const orgId = randomUUID();
    await enqueue(orgId, "sub_live");
    const canceller = fakeCanceller();

    const result = await drainBillingCancellations({
      billing,
      canceller,
      limit: 100,
      maxAttempts: 5,
    });

    expect(canceller.ids).toEqual(["sub_live"]);
    expect(result).toMatchObject({ claimed: 1, canceled: 1, retried: 0, failed: 0 });
    const job = await readJob(orgId);
    expect(job!.status).toBe("canceled");
    expect(job!.canceled_at).not.toBeNull();
  });

  it("treats resource_missing (already gone at Stripe) as an idempotent success", async () => {
    const orgId = randomUUID();
    await enqueue(orgId, "sub_gone");
    const canceller = fakeCanceller(() => {
      throw new StripeError(
        404,
        "No such subscription",
        "invalid_request_error",
        "resource_missing",
      );
    });

    const result = await drainBillingCancellations({
      billing,
      canceller,
      limit: 100,
      maxAttempts: 5,
    });

    expect(result).toMatchObject({ canceled: 1, alreadyGone: 1, failed: 0 });
    expect((await readJob(orgId))!.status).toBe("canceled");
  });

  it("leaves a transiently-failing (5xx) job pending with an incremented attempt count", async () => {
    const orgId = randomUUID();
    await enqueue(orgId, "sub_flaky");
    const canceller = fakeCanceller(() => {
      throw new StripeError(503, "gateway", "api_error", undefined);
    });

    const result = await drainBillingCancellations({
      billing,
      canceller,
      limit: 100,
      maxAttempts: 5,
    });

    expect(result).toMatchObject({ canceled: 0, retried: 1, failed: 0 });
    const job = await readJob(orgId);
    expect(job!.status).toBe("pending");
    expect(job!.attempts).toBe(1);
  });

  it("marks a TERMINAL 4xx (e.g. revoked key = 401) failed on the FIRST attempt — no week of silent retries", async () => {
    const orgId = randomUUID();
    await enqueue(orgId, "sub_authfail");
    const canceller = fakeCanceller(() => {
      throw new StripeError(401, "Invalid API Key", "authentication_error", undefined);
    });

    const result = await drainBillingCancellations({
      billing,
      canceller,
      limit: 100,
      maxAttempts: 168,
    });

    expect(result).toMatchObject({ failed: 1, retried: 0 });
    const job = await readJob(orgId);
    expect(job!.status).toBe("failed");
    expect(job!.attempts).toBe(1); // alarmed immediately, not after the cap
  });

  it("marks a transiently-failing job failed once attempts reach maxAttempts (alarm, stops retrying)", async () => {
    const orgId = randomUUID();
    await enqueue(orgId, "sub_dead");
    // Pre-set attempts to one below the cap so the next TRANSIENT (5xx) failure crosses it.
    await admin`update org_billing_cancellations set attempts = 4 where org_id = ${orgId}`;
    const canceller = fakeCanceller(() => {
      throw new StripeError(500, "server error", "api_error", undefined);
    });

    const result = await drainBillingCancellations({
      billing,
      canceller,
      limit: 100,
      maxAttempts: 5,
    });

    expect(result).toMatchObject({ failed: 1, retried: 0 });
    const job = await readJob(orgId);
    expect(job!.status).toBe("failed");
    expect(job!.attempts).toBe(5);
  });

  it("reports capped when the claimed set hits the limit", async () => {
    await enqueue(randomUUID(), "sub_a");
    await enqueue(randomUUID(), "sub_b");
    const canceller = fakeCanceller();
    const result = await drainBillingCancellations({
      billing,
      canceller,
      limit: 1,
      maxAttempts: 5,
    });
    expect(result.capped).toBe(true);
    expect(result.claimed).toBe(1);
  });
});

describe("org_billing_cancellations RLS — a tenant cannot forge a cancellation", () => {
  const rlsDenied = /row-level security|violates|policy/i;

  it("webhook_app CAN enqueue its own org's own live subscription", async () => {
    const org = await seedOrg();
    const subId = await seedSubscription(org, "active");
    await withTenant(
      app,
      org,
      (tx) =>
        tx`insert into org_billing_cancellations (org_id, stripe_subscription_id)
           values (${org}, ${subId})`,
    );
    expect((await readJob(org))!.stripe_subscription_id).toBe(subId);
  });

  it("rejects a FORGED foreign subscription id under the tenant's own org (the hardened with-check)", async () => {
    const org = await seedOrg(); // no billing_subscriptions row → any sub id is foreign
    await expect(
      withTenant(
        app,
        org,
        (tx) =>
          tx`insert into org_billing_cancellations (org_id, stripe_subscription_id)
             values (${org}, ${"sub_victim"})`,
      ),
    ).rejects.toThrow(rlsDenied);
  });

  it("rejects enqueuing for ANOTHER org (org_id must equal current_org_id)", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const subB = await seedSubscription(orgB, "active");
    await expect(
      withTenant(
        app,
        orgA,
        (tx) =>
          tx`insert into org_billing_cancellations (org_id, stripe_subscription_id)
             values (${orgB}, ${subB})`,
      ),
    ).rejects.toThrow(rlsDenied);
  });

  it("does not let webhook_app SELECT another org's cancellation job", async () => {
    const orgA = await seedOrg();
    const orgB = randomUUID();
    await admin`insert into org_billing_cancellations (org_id, stripe_subscription_id)
                values (${orgB}, ${"sub_b"})`;
    const rows = await withTenant(
      app,
      orgA,
      (tx) => tx<{ orgId: string }[]>`select org_id as "orgId" from org_billing_cancellations`,
    );
    expect(rows).toHaveLength(0);
  });

  it("webhook_billing UPDATE touches only pending rows (a completed job is immutable)", async () => {
    const org = randomUUID();
    await admin`insert into org_billing_cancellations (org_id, stripe_subscription_id, status)
                values (${org}, ${"sub_done"}, ${"canceled"})`;
    const res = await billing`
      update org_billing_cancellations set attempts = attempts + 1 where org_id = ${org}`;
    expect(res.count).toBe(0);
  });
});
