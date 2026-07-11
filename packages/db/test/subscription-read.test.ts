import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { readActiveSubscription } from "../src/reads";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// readActiveSubscription now also returns the subscription's OWN included volume (`event_cap`), which the
// usage-based cancellation refund (slice 2.4) divides by. It reads the cap from `billing_subscriptions` —
// what the customer actually BOUGHT — rather than the `org_limits` mirror, whose decrease-defer window can
// hold a different value mid-cycle. A wrong denominator is a wrong refund, i.e. real money.

let pg: EphemeralPostgres;
let app: Sql;
let admin: Sql; // billing_subscriptions is SELECT-only for the app role — seed as owner

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  admin = createClient(pg.ownerUrl);
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await pg?.stop();
});

async function seedOrg(slug: string): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
  });
  return orgId;
}

async function seedSub(orgId: string, eventCap: number | null): Promise<void> {
  await admin`
    insert into billing_subscriptions
      (org_id, stripe_subscription_id, plan, status, event_cap,
       current_period_start, current_period_end)
    values (${orgId}, ${`sub_${orgId.slice(0, 8)}`}, ${"price_base_pro"}, ${"active"}, ${eventCap},
            ${"2026-07-01T00:00:00Z"}, ${"2026-08-01T00:00:00Z"})`;
}

describe("readActiveSubscription", () => {
  it("returns the subscription's included volume (event_cap) alongside its id/plan/status", async () => {
    const orgId = await seedOrg("cap-org");
    await seedSub(orgId, 500_000);

    const sub = await withTenant(app, orgId, (tx) => readActiveSubscription(tx));
    expect(sub).toEqual({
      subscriptionId: `sub_${orgId.slice(0, 8)}`,
      plan: "price_base_pro",
      status: "active",
      eventCap: 500_000,
    });
  });

  it("returns eventCap null for an UNLIMITED plan (no denominator → the refund must decline, not divide)", async () => {
    const orgId = await seedOrg("unlimited-org");
    await seedSub(orgId, null);

    const sub = await withTenant(app, orgId, (tx) => readActiveSubscription(tx));
    expect(sub?.eventCap).toBeNull();
  });

  it("returns null when the org has no subscription at all", async () => {
    const orgId = await seedOrg("free-org");
    expect(await withTenant(app, orgId, (tx) => readActiveSubscription(tx))).toBeNull();
  });

  it("is RLS-scoped — one org never reads another's subscription or its cap", async () => {
    const mine = await seedOrg("mine-sub");
    const theirs = await seedOrg("theirs-sub");
    await seedSub(theirs, 3_000_000);

    // `theirs` has a subscription; reading as `mine` must not see it (RLS pins the org).
    expect(await withTenant(app, mine, (tx) => readActiveSubscription(tx))).toBeNull();
    expect(await withTenant(app, theirs, (tx) => readActiveSubscription(tx))).not.toBeNull();
  });
});
