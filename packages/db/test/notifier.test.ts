import { randomUUID } from "node:crypto";

import { newId } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import { createEndpoint } from "../src/endpoints";
import { insertNotificationIntent } from "../src/delivery";
import { listPendingNotifications, markNotificationSent } from "../src/notifier";
import { createReplayDestination } from "../src/replay-destinations";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The notification notifier (S3 Slice 3 PR3c-3): the auth. worker's cron drains pending notification_intents
// (written by the engine's auto-disable) → emails the org owner → marks them sent. This is the db half — a
// cross-org read joining an intent to its org's OWNER email, and a single-flight mark-sent — run on a
// webhook_notifier connection (NOBYPASSRLS + role-targeted policies), NOT a tenant tx. Against real Postgres.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5) });
let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql; // seeds the global identity `user` rows (ungranted to webhook_app)
let notifier: Sql;

/** Seed an org with an OWNER membership (+ the owner's identity email) and return its ids. */
async function seedOrgWithOwner(email: string): Promise<{ orgId: string; endpointId: string }> {
  const orgId = randomUUID();
  const userId = `user_${randomUUID()}`;
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${userId}, ${"Owner"}, ${email}, ${true}, now())`;
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${randomUUID().slice(0, 8)}, ${"Org"})`;
    await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${"owner"})`;
  });
  const endpointId = (await createEndpoint(app, { orgId, name: "ep" }, hasher)).id;
  return { orgId, endpointId };
}

/** Queue a pending destination-disabled intent for an org. Returns the intent id + destination id. */
async function seedIntent(orgId: string): Promise<{ intentId: string; destinationId: string }> {
  const destinationId = (
    await createReplayDestination(app, { orgId, url: `https://d-${newId()}.example.com/in` })
  ).id;
  const intentId = await withTenant(app, orgId, (tx) =>
    insertNotificationIntent(tx, { orgId, kind: "destination_disabled", destinationId }),
  );
  return { intentId, destinationId };
}

const pendingFor = async (orgId: string) =>
  (await listPendingNotifications(notifier)).filter((n) => n.orgId === orgId);

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  notifier = createClient(pg.urlFor({ role: DB_ROLES.notifier }));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await notifier?.end();
  await pg?.stop();
});

describe("listPendingNotifications", () => {
  it("surfaces a pending intent with its org owner's email + routing keys", async () => {
    const { orgId } = await seedOrgWithOwner("owner-a@example.test");
    const { intentId, destinationId } = await seedIntent(orgId);
    const rows = await pendingFor(orgId);
    expect(rows).toEqual([
      {
        intentId,
        orgId,
        kind: "destination_disabled",
        destinationId,
        ownerEmails: ["owner-a@example.test"],
      },
    ]);
  });

  it("reads across tenants from a context-less notifier connection", async () => {
    const a = await seedOrgWithOwner("xa@example.test");
    const b = await seedOrgWithOwner("xb@example.test");
    const ia = await seedIntent(a.orgId);
    const ib = await seedIntent(b.orgId);
    const all = await listPendingNotifications(notifier);
    const ids = new Set(all.map((n) => n.intentId));
    expect(ids).toContain(ia.intentId);
    expect(ids).toContain(ib.intentId);
  });

  it("collects ALL owner emails when an org has several owners", async () => {
    const { orgId } = await seedOrgWithOwner("owner1@example.test");
    // add a second owner
    const u2 = `user_${randomUUID()}`;
    await owner`insert into "user" ("id","name","email","emailVerified","updatedAt")
                values (${u2}, ${"O2"}, ${"owner2@example.test"}, ${true}, now())`;
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${u2}, ${"owner"})`,
    );
    const { intentId } = await seedIntent(orgId);
    const row = (await pendingFor(orgId)).find((n) => n.intentId === intentId);
    expect(row?.ownerEmails.sort()).toEqual(["owner1@example.test", "owner2@example.test"]);
  });

  it("treats a single email containing a comma as ONE recipient (no delimiter mis-split)", async () => {
    // RFC 5321 quoted local-parts can legally contain a comma. The owner aggregation must not split such an
    // address into two bogus recipients — emails are grouped in JS, not by a delimiter-joined SQL string.
    const orgId = randomUUID();
    const userId = `user_${randomUUID()}`;
    const commaEmail = '"a,b"@example.test';
    await owner`insert into "user" ("id","name","email","emailVerified","updatedAt")
                values (${userId}, ${"Comma"}, ${commaEmail}, ${true}, now())`;
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${orgId}, ${randomUUID().slice(0, 8)}, ${"Org"})`;
      await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${"owner"})`;
    });
    const { intentId } = await seedIntent(orgId);
    const row = (await pendingFor(orgId)).find((n) => n.intentId === intentId);
    expect(row?.ownerEmails).toEqual([commaEmail]);
  });

  it("excludes an already-sent intent (only pending)", async () => {
    const { orgId } = await seedOrgWithOwner("sent@example.test");
    const { intentId } = await seedIntent(orgId);
    await markNotificationSent(notifier, intentId);
    expect((await pendingFor(orgId)).map((n) => n.intentId)).not.toContain(intentId);
  });

  it("surfaces an ownerless org's intent with EMPTY recipients (so the drain can claim + clear it)", async () => {
    // An org whose sole owner's account was deleted (cascading the membership away) has no resolvable owner.
    // The intent must still be returned — with no recipients — not silently dropped to rot in the pending index.
    const orgId = randomUUID();
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into orgs (id, slug, name) values (${orgId}, ${randomUUID().slice(0, 8)}, ${"Org"})`,
    );
    const { intentId } = await seedIntent(orgId);
    const row = (await pendingFor(orgId)).find((n) => n.intentId === intentId);
    expect(row).toBeDefined();
    expect(row?.ownerEmails).toEqual([]);
  });

  it("does NOT surface an admin/member as the recipient (owner-only)", async () => {
    const { orgId } = await seedOrgWithOwner("theowner@example.test");
    const member = `user_${randomUUID()}`;
    await owner`insert into "user" ("id","name","email","emailVerified","updatedAt")
                values (${member}, ${"M"}, ${"member@example.test"}, ${true}, now())`;
    await withTenant(
      app,
      orgId,
      (tx) =>
        tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${member}, ${"member"})`,
    );
    const { intentId } = await seedIntent(orgId);
    const row = (await pendingFor(orgId)).find((n) => n.intentId === intentId);
    expect(row?.ownerEmails).toEqual(["theowner@example.test"]);
  });
});

describe("markNotificationSent", () => {
  it("flips a pending intent to sent exactly once (single-flight)", async () => {
    const { orgId } = await seedOrgWithOwner("once@example.test");
    const { intentId } = await seedIntent(orgId);
    expect(await markNotificationSent(notifier, intentId)).toBe(true);
    // second attempt is a no-op — already sent
    expect(await markNotificationSent(notifier, intentId)).toBe(false);
    // and it stamped sent_at
    const [row] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ status: string; sent_at: Date | null }[]>`
        select status, sent_at from notification_intents where id = ${intentId}`,
    );
    expect(row!.status).toBe("sent");
    expect(row!.sent_at).not.toBeNull();
  });

  it("claims exactly once when two drains race the SAME intent concurrently", async () => {
    // The load-bearing guarantee: under two overlapping cron passes, only one claims → only one sends.
    // Fire both marks concurrently against one pending row; the Postgres row-lock re-check must let exactly
    // one win. (Sequential can't prove this — the second could pass on a dropped status guard.)
    const { orgId } = await seedOrgWithOwner("race@example.test");
    const { intentId } = await seedIntent(orgId);
    const [a, b] = await Promise.all([
      markNotificationSent(notifier, intentId),
      markNotificationSent(notifier, intentId),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one claimant
  });
});

describe("webhook_notifier RLS UPDATE bound (behavioral, not just grants)", () => {
  it("cannot re-open a sent intent (USING status='pending' hides it) nor set an arbitrary status", async () => {
    const { orgId } = await seedOrgWithOwner("bound@example.test");
    const { intentId } = await seedIntent(orgId);
    await markNotificationSent(notifier, intentId); // now 'sent'

    // Re-open sent→pending: the USING clause makes the sent row invisible to the notifier's UPDATE → 0 rows.
    const reopen = await notifier`
      update notification_intents set status = 'pending' where id = ${intentId}`;
    expect(reopen.count).toBe(0);

    // Set an arbitrary status on a (fresh) pending row: WITH CHECK (status='sent') rejects the post-image.
    const fresh = await seedIntent(orgId);
    await expect(
      notifier`update notification_intents set status = 'bogus' where id = ${fresh.intentId}`,
    ).rejects.toThrow(/row-level security|violates|check/i);

    // The sent row is untouched, the fresh row is still pending.
    const rows = await withTenant(
      app,
      orgId,
      (tx) => tx<{ id: string; status: string }[]>`
        select id, status from notification_intents where id in ${tx([intentId, fresh.intentId])}`,
    );
    expect(new Map(rows.map((r) => [r.id, r.status]))).toEqual(
      new Map([
        [intentId, "sent"],
        [fresh.intentId, "pending"],
      ]),
    );
  });

  it("cannot INSERT or DELETE notification_intents (no such grant)", async () => {
    const { orgId } = await seedOrgWithOwner("nodel@example.test");
    const { intentId, destinationId } = await seedIntent(orgId);
    await expect(
      notifier`insert into notification_intents (id, org_id, kind, destination_id)
               values (${randomUUID()}, ${orgId}, ${"destination_disabled"}, ${destinationId})`,
    ).rejects.toThrow(/permission denied/i);
    await expect(notifier`delete from notification_intents where id = ${intentId}`).rejects.toThrow(
      /permission denied/i,
    );
  });
});
