import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "../src/credential";
import {
  bootstrapPersonalOrg,
  createMembership,
  getConsentOrg,
  isOrgMember,
  personalOrgId,
} from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// bootstrapPersonalOrg + createMembership against a REAL Postgres: the atomic signup primitive
// (org + owner membership + default endpoint in ONE tx), idempotent via a deterministic per-user org
// id + ON CONFLICT (no cross-org lookup — RLS forbids one), and RLS isolation. Lane C A1 calls
// bootstrapPersonalOrg once at signup.

const hasher = createCredentialHasher({ current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x7c) });

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql; // webhook_owner — seeds the better-auth "user" rows (ungranted to webhook_app)

async function seedUser(userId: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${userId}, ${"Seed"}, ${`${userId}@e.test`}, ${true}, now())`;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await pg?.stop();
});

describe("bootstrapPersonalOrg", () => {
  it("atomically creates the org + owner membership + default endpoint, returning the ingest token once", async () => {
    const userId = `user_${randomUUID()}`;
    await seedUser(userId);
    const res = await bootstrapPersonalOrg(
      app,
      { userId, slug: `s-${userId.slice(5, 13)}`, name: "Personal" },
      hasher,
    );
    expect(res.created).toBe(true);
    expect(res.ingestToken).toBeDefined();
    expect(res.ingestToken!.length).toBeGreaterThan(10);

    // All three rows exist under the new org's context.
    const [org] = await withTenant(
      app,
      res.orgId,
      (tx) => tx<{ id: string }[]>`select id from orgs where id = ${res.orgId}`,
    );
    expect(org?.id).toBe(res.orgId);
    const [m] = await withTenant(
      app,
      res.orgId,
      (tx) =>
        tx<
          { role: string }[]
        >`select role from memberships where org_id = ${res.orgId} and user_id = ${userId}`,
    );
    expect(m?.role).toBe("owner");
    const [ep] = await withTenant(
      app,
      res.orgId,
      (tx) => tx<{ id: string }[]>`select id from endpoints where id = ${res.endpointId}`,
    );
    expect(ep?.id).toBe(res.endpointId);
  });

  it("is idempotent: a re-run returns the SAME org/endpoint, created:false, no dupes, no new token", async () => {
    const userId = `user_${randomUUID()}`;
    await seedUser(userId);
    const input = { userId, slug: `s-${userId.slice(5, 13)}`, name: "Personal" };
    const first = await bootstrapPersonalOrg(app, input, hasher);
    const second = await bootstrapPersonalOrg(app, input, hasher);

    expect(second.orgId).toBe(first.orgId);
    expect(second.endpointId).toBe(first.endpointId);
    expect(second.created).toBe(false);
    expect(second.ingestToken).toBeUndefined(); // the one-time token is not re-revealed

    // Exactly one org / membership / endpoint — no duplicates.
    const counts = await withTenant(app, first.orgId, async (tx) => {
      const [o] = await tx<
        { n: number }[]
      >`select count(*)::int as n from orgs where id = ${first.orgId}`;
      const [mem] = await tx<
        { n: number }[]
      >`select count(*)::int as n from memberships where org_id = ${first.orgId}`;
      const [e] = await tx<
        { n: number }[]
      >`select count(*)::int as n from endpoints where org_id = ${first.orgId}`;
      return { o: o.n, mem: mem.n, e: e.n };
    });
    expect(counts).toEqual({ o: 1, mem: 1, e: 1 });
  });

  it("gives different users different personal orgs", async () => {
    const a = `user_${randomUUID()}`;
    const b = `user_${randomUUID()}`;
    await seedUser(a);
    await seedUser(b);
    const ra = await bootstrapPersonalOrg(
      app,
      { userId: a, slug: `s-${a.slice(5, 13)}`, name: "A" },
      hasher,
    );
    const rb = await bootstrapPersonalOrg(
      app,
      { userId: b, slug: `s-${b.slice(5, 13)}`, name: "B" },
      hasher,
    );
    expect(ra.orgId).not.toBe(rb.orgId);
  });
});

describe("createMembership", () => {
  it("adds a member to an org under its RLS context", async () => {
    const userId = `user_${randomUUID()}`;
    const memberId = `user_${randomUUID()}`;
    await seedUser(userId);
    await seedUser(memberId);
    const { orgId } = await bootstrapPersonalOrg(
      app,
      { userId, slug: `s-${userId.slice(5, 13)}`, name: "Org" },
      hasher,
    );
    await createMembership(app, { orgId, userId: memberId, role: "member" });
    const [m] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<
          { role: string }[]
        >`select role from memberships where org_id = ${orgId} and user_id = ${memberId}`,
    );
    expect(m?.role).toBe("member");
  });

  it("RLS forbids writing a membership into another org (cross-org insert rejected)", async () => {
    const uA = `user_${randomUUID()}`;
    const uB = `user_${randomUUID()}`;
    await seedUser(uA);
    await seedUser(uB);
    const a = await bootstrapPersonalOrg(
      app,
      { userId: uA, slug: `s-${uA.slice(5, 13)}`, name: "A" },
      hasher,
    );
    const b = await bootstrapPersonalOrg(
      app,
      { userId: uB, slug: `s-${uB.slice(5, 13)}`, name: "B" },
      hasher,
    );
    // Under org A's context, a raw insert targeting org B's id violates the WITH CHECK policy.
    await expect(
      withTenant(
        app,
        a.orgId,
        (tx) =>
          tx`insert into memberships (org_id, user_id, role) values (${b.orgId}, ${uA}, 'member')`,
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });
});

describe("isOrgMember (the /token tenancy bind)", () => {
  it("is true for a member, false for a non-member of the same org", async () => {
    const owner = `user_${randomUUID()}`;
    const member = `user_${randomUUID()}`;
    const stranger = `user_${randomUUID()}`;
    await seedUser(owner);
    await seedUser(member);
    await seedUser(stranger);
    const { orgId } = await bootstrapPersonalOrg(
      app,
      { userId: owner, slug: `s-${owner.slice(5, 13)}`, name: "Org" },
      hasher,
    );
    await createMembership(app, { orgId, userId: member, role: "member" });

    expect(await isOrgMember(app, owner, orgId)).toBe(true);
    expect(await isOrgMember(app, member, orgId)).toBe(true);
    expect(await isOrgMember(app, stranger, orgId)).toBe(false);
  });

  it("is false when the user is a member of a DIFFERENT org (no cross-org bleed)", async () => {
    const uA = `user_${randomUUID()}`;
    const uB = `user_${randomUUID()}`;
    await seedUser(uA);
    await seedUser(uB);
    const a = await bootstrapPersonalOrg(
      app,
      { userId: uA, slug: `s-${uA.slice(5, 13)}`, name: "A" },
      hasher,
    );
    const b = await bootstrapPersonalOrg(
      app,
      { userId: uB, slug: `s-${uB.slice(5, 13)}`, name: "B" },
      hasher,
    );
    // uA owns org A but is NOT a member of org B — asking about (uA, B) must be false.
    expect(await isOrgMember(app, uA, a.orgId)).toBe(true);
    expect(await isOrgMember(app, uA, b.orgId)).toBe(false);
  });
});

describe("getConsentOrg + personalOrgId (the /authorize consent-org resolution)", () => {
  it("resolves the bootstrapped personal org id + display name", async () => {
    const userId = `user_${randomUUID()}`;
    await seedUser(userId);
    const { orgId } = await bootstrapPersonalOrg(
      app,
      { userId, slug: `s-${userId.slice(5, 13)}`, name: "Dana's projects" },
      hasher,
    );
    // personalOrgId derives the SAME id bootstrap used — no DB read, no cross-org query.
    expect(personalOrgId(userId)).toBe(orgId);

    const resolved = await getConsentOrg(app, userId);
    expect(resolved).toEqual({ orgId, name: "Dana's projects" });
  });

  it("returns null for a user with no personal org", async () => {
    const userId = `user_${randomUUID()}`;
    await seedUser(userId);
    expect(await getConsentOrg(app, userId)).toBeNull();
  });

  it("is membership-gated: returns null when the org exists but the user is not a member", async () => {
    const userId = `user_${randomUUID()}`;
    await seedUser(userId);
    const { orgId } = await bootstrapPersonalOrg(
      app,
      { userId, slug: `s-${userId.slice(5, 13)}`, name: "Org" },
      hasher,
    );
    // Drop the owner membership while the org row survives — the resolution must fail closed.
    await withTenant(
      app,
      orgId,
      (tx) => tx`delete from memberships where org_id = ${orgId} and user_id = ${userId}`,
    );
    expect(await getConsentOrg(app, userId)).toBeNull();
  });
});

describe("bootstrapPersonalOrg — hardening", () => {
  it("stores the ingest token HASHED (keyed HMAC of the revealed plaintext), never plaintext", async () => {
    const userId = `user_${randomUUID()}`;
    await seedUser(userId);
    const res = await bootstrapPersonalOrg(
      app,
      { userId, slug: `s-${userId.slice(5, 13)}`, name: "Org" },
      hasher,
    );
    const [ep] = await withTenant(
      app,
      res.orgId,
      (tx) =>
        tx<{ ingest_token_hash: Buffer }[]>`
        select ingest_token_hash from endpoints where id = ${res.endpointId}`,
    );
    expect(Buffer.compare(ep!.ingest_token_hash, hasher.hash(res.ingestToken!))).toBe(0);
    // The stored bytes are NOT the plaintext.
    expect(ep!.ingest_token_hash.toString("utf8")).not.toContain(res.ingestToken!);
  });

  it("self-heals: if the default endpoint is deleted, a re-run re-mints it (new token)", async () => {
    const userId = `user_${randomUUID()}`;
    await seedUser(userId);
    const input = { userId, slug: `s-${userId.slice(5, 13)}`, name: "Org" };
    const first = await bootstrapPersonalOrg(app, input, hasher);
    // Delete the default endpoint while the org survives.
    await withTenant(
      app,
      first.orgId,
      (tx) => tx`delete from endpoints where id = ${first.endpointId}`,
    );

    const healed = await bootstrapPersonalOrg(app, input, hasher);
    expect(healed.created).toBe(false); // the org already existed
    expect(healed.ingestToken).toBeDefined(); // but the endpoint was re-minted
    const [ep] = await withTenant(
      app,
      first.orgId,
      (tx) => tx<{ id: string }[]>`select id from endpoints where id = ${first.endpointId}`,
    );
    expect(ep?.id).toBe(first.endpointId);
  });

  it("serializes concurrent bootstraps for one user: exactly one creates the org + one token", async () => {
    const userId = `user_${randomUUID()}`;
    await seedUser(userId);
    const input = { userId, slug: `s-${userId.slice(5, 13)}`, name: "Org" };
    const [a, b] = await Promise.all([
      bootstrapPersonalOrg(app, input, hasher),
      bootstrapPersonalOrg(app, input, hasher),
    ]);
    expect(a.orgId).toBe(b.orgId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1); // exactly one created the org
    expect([a.ingestToken, b.ingestToken].filter(Boolean)).toHaveLength(1); // exactly one token minted
    // No duplicate rows.
    const [{ n }] = await withTenant(
      app,
      a.orgId,
      (tx) =>
        tx<{ n: number }[]>`select count(*)::int as n from endpoints where org_id = ${a.orgId}`,
    );
    expect(n).toBe(1);
  });
});
