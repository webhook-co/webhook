import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  changeMemberRole,
  LastOwnerError,
  listOrgMembers,
  MemberCeilingError,
  MemberNotFoundError,
  removeMember,
} from "../src/members";
import { createOrgWithOwner } from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// Member management (Lane 2.6) against a real Postgres. The load-bearing invariants:
//   - you cannot act on someone who outranks you, nor grant a role above your own (the ceiling);
//   - the LAST OWNER can never be demoted or removed (a zero-owner org is unreachable forever);
//   - a removal DELETES the membership and REVOKES, in the same tx, the member's grants, the keys minted
//     under those grants, and every key they created — a credential minted under an authority they no
//     longer hold must die, and they may still hold its plaintext;
//   - a DEMOTION revokes the same keys (minted above the new ceiling); a PROMOTION revokes nothing;
//   - every mutation writes a tamper-evident auth_audit_event in the SAME tx.

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0);

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;
let key: CryptoKey;

async function seedUser(id: string, email: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${id}, ${email}, ${true}, now())`;
}

/** An org with an owner. */
async function seedOrg(): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = `u_own_${randomUUID().slice(0, 8)}`;
  await seedUser(ownerId, `${ownerId}@acme.test`);
  const { id } = await createOrgWithOwner(app, {
    slug: `s-${randomUUID().slice(0, 8)}`,
    name: "Acme",
    ownerUserId: ownerId,
  });
  return { orgId: id, ownerId };
}

/** Add a member at `role` to an org. */
async function seedMember(orgId: string, role: "owner" | "admin" | "member"): Promise<string> {
  const userId = `u_${role}_${randomUUID().slice(0, 8)}`;
  await seedUser(userId, `${userId}@acme.test`);
  await withTenant(
    app,
    orgId,
    (tx) =>
      tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`,
  );
  return userId;
}

/** A grant for `userId` in `orgId`, plus one api_key minted under it. Returns their ids. */
async function seedGrantWithKey(
  orgId: string,
  userId: string,
): Promise<{ grantId: string; keyId: string }> {
  const grantId = randomUUID();
  const keyId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`
      insert into auth_grant (id, org_id, user_id, status, auth_method)
      values (${grantId}, ${orgId}, ${userId}, 'active', 'pkce_loopback')`;
    await tx`
      insert into api_keys (id, org_id, name, key_hash, prefix, start, scopes, grant_id, created_by)
      values (${keyId}, ${orgId}, 'cli', ${Buffer.from(randomUUID())}, 'whk', 'whk_aaaa',
              ${["events:read"]}, ${grantId}, ${userId})`;
  });
  return { grantId, keyId };
}

/** A standalone key CREATED BY `userId` (no grant). owner_type defaults to 'user'. */
async function seedStandaloneKey(
  orgId: string,
  userId: string,
  ownerType: "user" | "org" = "user",
): Promise<string> {
  const keyId = randomUUID();
  await withTenant(
    app,
    orgId,
    (tx) => tx`
      insert into api_keys (id, org_id, name, key_hash, prefix, start, scopes, created_by, owner_type)
      values (${keyId}, ${orgId}, 'ci', ${Buffer.from(randomUUID())}, 'whk', 'whk_bbbb',
              ${["events:read"]}, ${userId}, ${ownerType})`,
  );
  return keyId;
}

async function keyRevoked(orgId: string, keyId: string): Promise<boolean> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<
        { revoked_at: Date | null }[]
      >`select revoked_at from api_keys where id = ${keyId} and org_id = ${orgId}`,
  );
  return row?.revoked_at != null;
}

async function grantStatus(orgId: string, grantId: string): Promise<string | null> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<
        { status: string }[]
      >`select status from auth_grant where id = ${grantId} and org_id = ${orgId}`,
  );
  return row?.status ?? null;
}

async function membershipRole(orgId: string, userId: string): Promise<string | null> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<
        { role: string }[]
      >`select role from memberships where org_id = ${orgId} and user_id = ${userId}`,
  );
  return row?.role ?? null;
}

async function auditTypes(orgId: string): Promise<string[]> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<
        { event_type: string }[]
      >`select event_type from auth_audit_event where org_id = ${orgId} order by seq`,
  );
  return rows.map((r) => r.event_type);
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 3) % 256)));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await pg?.stop();
});

describe("listOrgMembers", () => {
  it("lists the org's members with their identity + role, and is RLS-scoped", async () => {
    const { orgId, ownerId } = await seedOrg();
    const memberId = await seedMember(orgId, "member");
    const other = await seedOrg(); // a second org must not bleed in

    const members = await listOrgMembers(app, orgId);
    expect(members.map((m) => m.userId).sort()).toEqual([memberId, ownerId].sort());
    const ownerRow = members.find((m) => m.userId === ownerId);
    expect(ownerRow).toMatchObject({ role: "owner", email: `${ownerId}@acme.test` });
    expect(members.find((m) => m.userId === memberId)).toMatchObject({ role: "member" });
    // The other org's owner is invisible here.
    expect(members.some((m) => m.userId === other.ownerId)).toBe(false);
  });
});

describe("changeMemberRole", () => {
  it("promotes a member to admin — nothing is revoked", async () => {
    const { orgId, ownerId } = await seedOrg();
    const memberId = await seedMember(orgId, "member");
    const keyId = await seedStandaloneKey(orgId, memberId);

    const res = await changeMemberRole(app, {
      orgId,
      userId: memberId,
      newRole: "admin",
      actorId: ownerId,
      actorRole: "owner",
      auditKey: key,
      now: NOW,
    });

    expect(res.changed).toBe(true);
    expect(res.revokedKeyHashes).toHaveLength(0); // a promotion takes nothing away
    expect(await membershipRole(orgId, memberId)).toBe("admin");
    expect(await keyRevoked(orgId, keyId)).toBe(false);
    expect(await auditTypes(orgId)).toContain("member_role_changed");
  });

  it("DEMOTES an admin to member and revokes the keys they minted under the higher role", async () => {
    const { orgId, ownerId } = await seedOrg();
    const adminId = await seedMember(orgId, "admin");
    const standalone = await seedStandaloneKey(orgId, adminId);
    const { keyId: grantKey } = await seedGrantWithKey(orgId, adminId);

    const res = await changeMemberRole(app, {
      orgId,
      userId: adminId,
      newRole: "member",
      actorId: ownerId,
      actorRole: "owner",
      auditKey: key,
      now: NOW,
    });

    expect(res.changed).toBe(true);
    expect(await membershipRole(orgId, adminId)).toBe("member");
    // Both credentials were minted under an authority they no longer hold.
    expect(await keyRevoked(orgId, standalone)).toBe(true);
    expect(await keyRevoked(orgId, grantKey)).toBe(true);
    expect(res.revokedKeyHashes).toHaveLength(2); // returned so the caller can evict the KV cache
  });

  it("refuses to grant a role above the actor's own (an admin cannot make someone an owner)", async () => {
    const { orgId } = await seedOrg();
    const adminId = await seedMember(orgId, "admin");
    const memberId = await seedMember(orgId, "member");
    await expect(
      changeMemberRole(app, {
        orgId,
        userId: memberId,
        newRole: "owner",
        actorId: adminId,
        actorRole: "admin",
        auditKey: key,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MemberCeilingError);
    expect(await membershipRole(orgId, memberId)).toBe("member");
  });

  it("refuses to act on someone who OUTRANKS the actor (an admin cannot demote an owner)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const adminId = await seedMember(orgId, "admin");
    await expect(
      changeMemberRole(app, {
        orgId,
        userId: ownerId,
        newRole: "member",
        actorId: adminId,
        actorRole: "admin",
        auditKey: key,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MemberCeilingError);
    expect(await membershipRole(orgId, ownerId)).toBe("owner");
  });

  it("refuses to demote the LAST owner (a zero-owner org is unreachable forever)", async () => {
    const { orgId, ownerId } = await seedOrg();
    await seedMember(orgId, "member");
    await expect(
      changeMemberRole(app, {
        orgId,
        userId: ownerId,
        newRole: "admin",
        actorId: ownerId,
        actorRole: "owner",
        auditKey: key,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(LastOwnerError);
    expect(await membershipRole(orgId, ownerId)).toBe("owner");
  });

  it("allows demoting an owner when ANOTHER owner remains", async () => {
    const { orgId, ownerId } = await seedOrg();
    const second = await seedMember(orgId, "owner");
    const res = await changeMemberRole(app, {
      orgId,
      userId: second,
      newRole: "member",
      actorId: ownerId,
      actorRole: "owner",
      auditKey: key,
      now: NOW,
    });
    expect(res.changed).toBe(true);
    expect(await membershipRole(orgId, second)).toBe("member");
  });

  it("is a no-op when the role is unchanged (no revoke, no audit)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const memberId = await seedMember(orgId, "member");
    const keyId = await seedStandaloneKey(orgId, memberId);
    const before = (await auditTypes(orgId)).length;

    const res = await changeMemberRole(app, {
      orgId,
      userId: memberId,
      newRole: "member",
      actorId: ownerId,
      actorRole: "owner",
      auditKey: key,
      now: NOW,
    });

    expect(res.changed).toBe(false);
    expect(res.revokedKeyHashes).toHaveLength(0);
    expect(await keyRevoked(orgId, keyId)).toBe(false);
    expect((await auditTypes(orgId)).length).toBe(before);
  });

  it("throws MemberNotFoundError for a non-member", async () => {
    const { orgId, ownerId } = await seedOrg();
    await expect(
      changeMemberRole(app, {
        orgId,
        userId: "u_stranger",
        newRole: "member",
        actorId: ownerId,
        actorRole: "owner",
        auditKey: key,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MemberNotFoundError);
  });
});

describe("removeMember", () => {
  it("deletes the membership and revokes the member's grants + every key they hold, in one tx", async () => {
    const { orgId, ownerId } = await seedOrg();
    const memberId = await seedMember(orgId, "member");
    const { grantId, keyId: grantKey } = await seedGrantWithKey(orgId, memberId);
    const personal = await seedStandaloneKey(orgId, memberId, "user");
    // An ORG-owned key they minted: they may still hold its plaintext, so it must die too.
    const service = await seedStandaloneKey(orgId, memberId, "org");
    // A key belonging to someone ELSE must survive.
    const ownersKey = await seedStandaloneKey(orgId, ownerId, "user");

    const res = await removeMember(app, {
      orgId,
      userId: memberId,
      actorId: ownerId,
      actorRole: "owner",
      auditKey: key,
      now: NOW,
    });

    expect(res.removed).toBe(true);
    expect(await membershipRole(orgId, memberId)).toBeNull();
    expect(await grantStatus(orgId, grantId)).toBe("revoked");
    expect(await keyRevoked(orgId, grantKey)).toBe(true);
    expect(await keyRevoked(orgId, personal)).toBe(true);
    expect(await keyRevoked(orgId, service)).toBe(true);
    expect(await keyRevoked(orgId, ownersKey)).toBe(false); // untouched
    // Every revoked hash comes back so the caller evicts the credential cache.
    expect(res.revokedKeyHashes).toHaveLength(3);
    expect(await auditTypes(orgId)).toContain("member_removed");
  });

  it("refuses to remove someone who OUTRANKS the actor", async () => {
    const { orgId, ownerId } = await seedOrg();
    const adminId = await seedMember(orgId, "admin");
    await expect(
      removeMember(app, {
        orgId,
        userId: ownerId,
        actorId: adminId,
        actorRole: "admin",
        auditKey: key,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MemberCeilingError);
    expect(await membershipRole(orgId, ownerId)).toBe("owner");
  });

  it("refuses to remove the LAST owner", async () => {
    const { orgId, ownerId } = await seedOrg();
    await seedMember(orgId, "member");
    await expect(
      removeMember(app, {
        orgId,
        userId: ownerId,
        actorId: ownerId,
        actorRole: "owner",
        auditKey: key,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(LastOwnerError);
    expect(await membershipRole(orgId, ownerId)).toBe("owner");
  });

  it("is idempotent — removing a non-member throws MemberNotFoundError, changing nothing", async () => {
    const { orgId, ownerId } = await seedOrg();
    await expect(
      removeMember(app, {
        orgId,
        userId: "u_ghost",
        actorId: ownerId,
        actorRole: "owner",
        auditKey: key,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(MemberNotFoundError);
  });
});
