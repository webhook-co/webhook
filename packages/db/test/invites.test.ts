import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  createCredentialHasher,
  CREDENTIAL_PEPPER_MIN_BYTES,
  type CredentialHasher,
} from "../src/credential";
import {
  acceptInvite,
  createInvite,
  InviteRoleCeilingError,
  listPendingInvites,
  revokeInvite,
} from "../src/invites";
import { createOrgWithOwner } from "../src/orgs";
import { testAuditKey } from "./audit-key";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// org_invites against a real Postgres: token stored ONLY as a hash, accept is single-use + email-matched +
// membership-in-the-same-tx, the role ceiling holds, and everything is RLS-scoped.

const NOW = Date.UTC(2026, 6, 12, 12, 0, 0);
const hasher: CredentialHasher = createCredentialHasher({
  current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x5c),
});

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;
let key: CryptoKey; // audit-chain HMAC key

async function seedUser(id: string, email: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${id}, ${email}, ${true}, now())`;
}

/** Seed an org owned by a fresh user; returns { orgId, ownerId }. */
async function seedOrg(): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = `u_own_${randomUUID().slice(0, 8)}`;
  await seedUser(ownerId, `${ownerId}@acme.test`);
  const { id } = await createOrgWithOwner(app, {
    slug: `s-${randomUUID().slice(0, 8)}`,
    name: "Acme",
    ownerUserId: ownerId,
    auditKey: await testAuditKey(),
  });
  return { orgId: id, ownerId };
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

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await pg?.stop();
});

describe("audit", () => {
  it("writes tamper-evident auth_audit_event rows for create / accept / revoke", async () => {
    const { orgId, ownerId } = await seedOrg();
    const email = `aud-${randomUUID().slice(0, 8)}@acme.test`;
    const a = await createInvite(app, hasher, {
      orgId,
      invitedEmail: email,
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    const accepterId = `u_aud_${randomUUID().slice(0, 8)}`;
    await seedUser(accepterId, email);
    await acceptInvite(app, hasher, {
      orgId,
      token: a.token,
      auditKey: key,
      userId: accepterId,
      userEmail: email,
      now: NOW + 1000,
    });
    // A second, revoked invite.
    const b = await createInvite(app, hasher, {
      orgId,
      invitedEmail: `aud2-${randomUUID().slice(0, 8)}@acme.test`,
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW + 2000,
    });
    await revokeInvite(app, {
      orgId,
      inviteId: b.id,
      revokedBy: ownerId,
      auditKey: key,
      now: NOW + 3000,
    });

    const events = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ event_type: string; target_id: string }[]>`
          select event_type, target_id from auth_audit_event where org_id = ${orgId} order by seq`,
    );
    // The org's very first audited event is its own creation (createOrgWithOwner writes org_created in-tx);
    // the invite lifecycle follows.
    expect(events.map((e) => e.event_type)).toEqual([
      "org_created",
      "invite_created",
      "invite_accepted",
      "invite_created",
      "invite_revoked",
    ]);
    // Each invite event links to its invite by target_id (offset by the leading org_created).
    expect(events[0]!.target_id).toBe(orgId);
    expect(events[1]!.target_id).toBe(a.id);
    expect(events[4]!.target_id).toBe(b.id);
  });
});

describe("createInvite", () => {
  it("enforces the role ceiling — an admin cannot invite an owner", async () => {
    const { orgId, ownerId } = await seedOrg();
    await expect(
      createInvite(app, hasher, {
        orgId,
        invitedEmail: "x@acme.test",
        role: "owner",
        invitedBy: ownerId,
        inviterRole: "admin",
        auditKey: key, // an admin can't grant owner
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InviteRoleCeilingError);
  });

  it("rejects a blank invited email (fail-open corner)", async () => {
    const { orgId, ownerId } = await seedOrg();
    await expect(
      createInvite(app, hasher, {
        orgId,
        invitedEmail: "   ",
        role: "member",
        invitedBy: ownerId,
        inviterRole: "owner",
        auditKey: key,
        now: NOW,
      }),
    ).rejects.toThrow(/non-empty/);
  });

  it("stores only a hash — the plaintext token is never persisted", async () => {
    const { orgId, ownerId } = await seedOrg();
    const invite = await createInvite(app, hasher, {
      orgId,
      invitedEmail: "bob@acme.test",
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    expect(invite.token).toMatch(/^whinv_/);
    const [row] = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<{ token_hash: Buffer }[]>`select token_hash from org_invites where id = ${invite.id}`,
    );
    // The stored hash is not the plaintext bytes.
    expect(row?.token_hash.toString("utf8")).not.toContain(invite.token);
    expect(row?.token_hash).toEqual(hasher.hash(invite.token)); // it IS the keyed hash
  });
});

describe("acceptInvite", () => {
  /** Seed an org + a pending invite + a matching accepter, all with a UNIQUE email ("user".email is unique). */
  async function invited(role: "admin" | "member" = "member") {
    const email = `bob-${randomUUID().slice(0, 8)}@acme.test`;
    const { orgId, ownerId } = await seedOrg();
    const invite = await createInvite(app, hasher, {
      orgId,
      invitedEmail: email,
      role,
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    const accepterId = `u_acc_${randomUUID().slice(0, 8)}`;
    await seedUser(accepterId, email);
    return { orgId, invite, accepterId, email };
  }

  it("accepts a valid invite once and creates the membership in the same tx", async () => {
    const { orgId, invite, accepterId, email } = await invited("admin");
    const res = await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: accepterId,
      userEmail: email,
      now: NOW + 1000,
    });
    expect(res).toEqual({ status: "accepted", role: "admin" });
    expect(await membershipRole(orgId, accepterId)).toBe("admin");
  });

  it("is single-use — a replay of the same token is invalid and adds no second membership", async () => {
    const { orgId, invite, accepterId, email } = await invited();
    await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: accepterId,
      userEmail: email,
      now: NOW + 1000,
    });
    const replay = await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: accepterId,
      userEmail: email,
      now: NOW + 2000,
    });
    expect(replay).toEqual({ status: "invalid" });
  });

  it("rejects a mismatched email and creates NO membership", async () => {
    const { orgId, invite } = await invited("member");
    const stranger = `u_str_${randomUUID().slice(0, 8)}`;
    const strangerEmail = `eve-${randomUUID().slice(0, 8)}@evil.test`;
    await seedUser(stranger, strangerEmail);
    const res = await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: stranger,
      userEmail: strangerEmail, // not the invited address
      now: NOW + 1000,
    });
    expect(res).toEqual({ status: "invalid" });
    expect(await membershipRole(orgId, stranger)).toBeNull();
  });

  it("matches the invited email case-insensitively (citext)", async () => {
    const { orgId, ownerId } = await seedOrg();
    const lower = `bob-${randomUUID().slice(0, 8)}@acme.test`;
    const upper = lower.replace("bob", "Bob").replace("@acme", "@Acme");
    const invite = await createInvite(app, hasher, {
      orgId,
      invitedEmail: upper, // invited with mixed case
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    const accepterId = `u_ci_${randomUUID().slice(0, 8)}`;
    await seedUser(accepterId, lower);
    const res = await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: accepterId,
      userEmail: lower,
      now: NOW + 1000,
    });
    expect(res).toEqual({ status: "accepted", role: "member" });
  });

  it("rejects an expired invite", async () => {
    const { orgId, ownerId } = await seedOrg();
    const email = `late-${randomUUID().slice(0, 8)}@acme.test`;
    const invite = await createInvite(app, hasher, {
      orgId,
      invitedEmail: email,
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      ttlMs: 1000,
      now: NOW,
    });
    const accepterId = `u_exp_${randomUUID().slice(0, 8)}`;
    await seedUser(accepterId, email);
    const res = await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: accepterId,
      userEmail: email,
      now: NOW + 5000,
    });
    expect(res).toEqual({ status: "invalid" });
  });

  it("rejects a garbage / unknown token", async () => {
    const { orgId } = await seedOrg();
    const res = await acceptInvite(app, hasher, {
      orgId,
      token: "whinv_nope",
      auditKey: key,
      userId: "u_x",
      userEmail: "x@acme.test",
      now: NOW,
    });
    expect(res).toEqual({ status: "invalid" });
  });

  it("does NOT change an existing member's role — consumes the invite, returns their ACTUAL role", async () => {
    // The owner (already a member at 'owner') accepts a 'member' invite addressed to them. Accept must not
    // demote them; it consumes the invite and returns the DB-truthful role.
    const { orgId, ownerId } = await seedOrg();
    const ownerEmail = `${ownerId}@acme.test`; // seedOrg seeds the owner with this email
    const invite = await createInvite(app, hasher, {
      orgId,
      invitedEmail: ownerEmail,
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    const res = await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: ownerId,
      userEmail: ownerEmail,
      now: NOW + 1000,
    });
    expect(res).toEqual({ status: "accepted", role: "owner" }); // not "member"
    expect(await membershipRole(orgId, ownerId)).toBe("owner"); // unchanged
  });

  it("cannot accept an invite from another org (RLS + explicit org_id)", async () => {
    const email = `xorg-${randomUUID().slice(0, 8)}@acme.test`;
    const a = await seedOrg();
    const invite = await createInvite(app, hasher, {
      orgId: a.orgId,
      invitedEmail: email,
      role: "member",
      invitedBy: a.ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    const b = await seedOrg(); // a different org
    const accepterId = `u_xorg_${randomUUID().slice(0, 8)}`;
    await seedUser(accepterId, email);
    // Present org A's token under org B's context → the row is invisible/unmatched → invalid.
    const res = await acceptInvite(app, hasher, {
      orgId: b.orgId,
      token: invite.token,
      auditKey: key,
      userId: accepterId,
      userEmail: email,
      now: NOW + 1000,
    });
    expect(res).toEqual({ status: "invalid" });
  });
});

describe("revokeInvite + listPendingInvites", () => {
  it("revokes a pending invite, and a revoked invite can no longer be accepted or listed", async () => {
    const { orgId, ownerId } = await seedOrg();
    const email = `gone-${randomUUID().slice(0, 8)}@acme.test`;
    const invite = await createInvite(app, hasher, {
      orgId,
      invitedEmail: email,
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    expect(
      await revokeInvite(app, {
        orgId,
        inviteId: invite.id,
        revokedBy: "u_revoker",
        auditKey: key,
        now: NOW + 500,
      }),
    ).toBe(true);
    // Not listable.
    expect((await listPendingInvites(app, orgId, NOW + 600)).map((i) => i.id)).not.toContain(
      invite.id,
    );
    // Not acceptable.
    const accepterId = `u_rev_${randomUUID().slice(0, 8)}`;
    await seedUser(accepterId, email);
    const res = await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: accepterId,
      userEmail: email,
      now: NOW + 700,
    });
    expect(res).toEqual({ status: "invalid" });
  });

  it("revokeInvite returns false for an unknown or already-accepted invite", async () => {
    const { orgId, ownerId } = await seedOrg();
    // Unknown id.
    expect(
      await revokeInvite(app, {
        orgId,
        inviteId: randomUUID(),
        revokedBy: "u_revoker",
        auditKey: key,
        now: NOW,
      }),
    ).toBe(false);
    // Already accepted → can't revoke.
    const email = `acc-${randomUUID().slice(0, 8)}@acme.test`;
    const invite = await createInvite(app, hasher, {
      orgId,
      invitedEmail: email,
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    const accepterId = `u_ra_${randomUUID().slice(0, 8)}`;
    await seedUser(accepterId, email);
    await acceptInvite(app, hasher, {
      orgId,
      token: invite.token,
      auditKey: key,
      userId: accepterId,
      userEmail: email,
      now: NOW + 1000,
    });
    expect(
      await revokeInvite(app, {
        orgId,
        inviteId: invite.id,
        revokedBy: "u_revoker",
        auditKey: key,
        now: NOW + 2000,
      }),
    ).toBe(false);
  });

  it("lists pending invites (no token), newest first", async () => {
    const { orgId, ownerId } = await seedOrg();
    const ea = `a-${randomUUID().slice(0, 8)}@acme.test`;
    const eb = `b-${randomUUID().slice(0, 8)}@acme.test`;
    const a = await createInvite(app, hasher, {
      orgId,
      invitedEmail: ea,
      role: "member",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW,
    });
    const b = await createInvite(app, hasher, {
      orgId,
      invitedEmail: eb,
      role: "admin",
      invitedBy: ownerId,
      inviterRole: "owner",
      auditKey: key,
      now: NOW + 1000,
    });
    const pending = await listPendingInvites(app, orgId, NOW + 2000);
    expect(pending.map((i) => i.invitedEmail)).toEqual([eb, ea]); // newest first
    // Never exposes a token.
    expect(JSON.stringify(pending)).not.toContain(a.token);
    expect(JSON.stringify(pending)).not.toContain(b.token);
    expect(pending[0]).toMatchObject({ role: "admin", start: expect.stringMatching(/^whinv_/) });
  });
});
