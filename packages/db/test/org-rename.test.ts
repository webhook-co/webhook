import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import {
  createOrgWithOwner,
  InvalidOrgSlugError,
  listUserOrgs,
  renameOrg,
  RenameForbiddenError,
  SlugTakenError,
  updateOrgImageKey,
} from "../src/orgs";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// createOrgWithOwner (validation + collision) and renameOrg (owner/admin, history-on-rename, audit) against a
// real Postgres. The DB is the authority for the slug rules; these prove the primitives surface the right
// TYPED failures and keep the audit + history invariants.

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql;
let auditKey: CryptoKey;

async function seedUser(id: string): Promise<void> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${id}, ${`${id}@acme.test`}, ${true}, now())`;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }), { max: 2 });
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }), { max: 2 });
  auditKey = await importAuditKey(new Uint8Array(32).fill(7));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end({ timeout: 5 }).catch(() => {});
  await owner?.end({ timeout: 5 }).catch(() => {});
  await pg?.stop();
});

/** A user + a team they own. */
async function seedTeam(slug: string): Promise<{ orgId: string; ownerId: string }> {
  const ownerId = `u_${randomUUID().slice(0, 8)}`;
  await seedUser(ownerId);
  const { id } = await createOrgWithOwner(app, {
    slug,
    name: "Acme",
    ownerUserId: ownerId,
    auditKey,
  });
  return { orgId: id, ownerId };
}

describe("updateOrgImageKey", () => {
  const logoKey = (orgId: string) => `org/${orgId}/logo.webp`;

  async function readImageKey(orgId: string): Promise<string | null> {
    const [row] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ image_key: string | null }[]>`select image_key from orgs where id = ${orgId}`,
    );
    return row?.image_key ?? null;
  }

  it("sets, then clears, the org's logo pointer under the pinned tenant", async () => {
    const { orgId } = await seedTeam(`logo-${randomUUID().slice(0, 6)}`);
    expect(await readImageKey(orgId)).toBeNull(); // no logo at creation

    await updateOrgImageKey(app, orgId, logoKey(orgId));
    expect(await readImageKey(orgId)).toBe(logoKey(orgId));

    await updateOrgImageKey(app, orgId, null); // remove
    expect(await readImageKey(orgId)).toBeNull();
  });

  it("only ever touches the pinned org — RLS keeps a stray id from writing another tenant's row", async () => {
    const a = await seedTeam(`logo-a-${randomUUID().slice(0, 6)}`);
    const b = await seedTeam(`logo-b-${randomUUID().slice(0, 6)}`);

    // withTenant pins org A; even handed org B's id, RLS (org_id = current_org_id()) matches no row, so B is
    // untouched and A's logo is unchanged (the UPDATE's WHERE finds nothing under A's tenant).
    await updateOrgImageKey(app, a.orgId, logoKey(a.orgId));
    await withTenant(
      app,
      a.orgId,
      (tx) => tx`update orgs set image_key = ${"tampered"} where id = ${b.orgId}`,
    );
    expect(await readImageKey(b.orgId)).toBeNull();
  });
});

describe("createOrgWithOwner", () => {
  it("creates the org + owner membership and writes an org_created audit row", async () => {
    const { orgId, ownerId } = await seedTeam(`acme-${randomUUID().slice(0, 6)}`);

    const role = await withTenant(
      app,
      orgId,
      (tx) => tx<{ role: string }[]>`select role from memberships where org_id = ${orgId}`,
    );
    expect(role.map((r) => r.role)).toEqual(["owner"]);

    const audit = await withTenant(
      app,
      orgId,
      (tx) =>
        tx<
          { event_type: string }[]
        >`select event_type from auth_audit_event where org_id = ${orgId}`,
    );
    expect(audit.map((a) => a.event_type)).toContain("org_created");
    void ownerId;
  });

  it("refuses a malformed or reserved slug with InvalidOrgSlugError — a caller bug, not a collision", async () => {
    const ownerId = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(ownerId);
    await expect(
      createOrgWithOwner(app, { slug: "settings", name: "X", ownerUserId: ownerId, auditKey }),
    ).rejects.toBeInstanceOf(InvalidOrgSlugError);
  });

  it("refuses a slug another org already holds with SlugTakenError", async () => {
    const slug = `taken-${randomUUID().slice(0, 6)}`;
    await seedTeam(slug);
    const ownerId = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(ownerId);
    await expect(
      createOrgWithOwner(app, { slug, name: "Dupe", ownerUserId: ownerId, auditKey }),
    ).rejects.toBeInstanceOf(SlugTakenError);
  });

  it("refuses a slug another org RETIRED (never-recycle) with SlugTakenError", async () => {
    // Org A takes `contested`, then renames away — retiring the slug forever. A create, not just a rename,
    // must be refused it (it is a prod mutation surface now, and this is GitHub's account-takeover bug: a new
    // owner reclaiming a retired name and hijacking its redirects). The trigger — not the app — closes it.
    const contested = `contested-${randomUUID().slice(0, 6)}`;
    const { orgId, ownerId: aOwner } = await seedTeam(contested);
    await renameOrg(app, {
      orgId,
      actorRole: "owner",
      actorId: aOwner,
      slug: `moved-${randomUUID().slice(0, 6)}`,
      auditKey,
    });

    const bOwner = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(bOwner);
    await expect(
      createOrgWithOwner(app, { slug: contested, name: "Squatter", ownerUserId: bOwner, auditKey }),
    ).rejects.toBeInstanceOf(SlugTakenError);
  });
});

describe("renameOrg", () => {
  it("renames the slug, records the OLD one in history, and audits — in one tx", async () => {
    const { orgId, ownerId } = await seedTeam(`initech-${randomUUID().slice(0, 6)}`);
    const before = (await listUserOrgs(app, ownerId))[0]!;
    const newSlug = `initech-new-${randomUUID().slice(0, 6)}`;

    const result = await renameOrg(app, {
      orgId,
      actorRole: "owner",
      actorId: ownerId,
      slug: newSlug,
      auditKey,
    });
    expect(result.slug).toBe(newSlug);

    const dir = (await listUserOrgs(app, ownerId))[0]!;
    expect(dir.slug).toBe(newSlug);
    expect(dir.formerSlugs).toContain(before.slug); // the trigger recorded it, the app did not

    const audit = await withTenant(
      app,
      orgId,
      (tx) => tx<{ event_type: string; metadata: unknown }[]>`
        select event_type, metadata from auth_audit_event
         where org_id = ${orgId} and event_type = 'org_renamed'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ fromSlug: before.slug, toSlug: newSlug });
  });

  it("renames the NAME without touching the slug or writing history", async () => {
    const { orgId, ownerId } = await seedTeam(`nameonly-${randomUUID().slice(0, 6)}`);
    const before = (await listUserOrgs(app, ownerId))[0]!;

    await renameOrg(app, {
      orgId,
      actorRole: "admin",
      actorId: ownerId,
      name: "Renamed Inc",
      auditKey,
    });

    const dir = (await listUserOrgs(app, ownerId))[0]!;
    expect(dir.name).toBe("Renamed Inc");
    expect(dir.slug).toBe(before.slug); // unchanged
    expect(dir.formerSlugs).toEqual([]); // a name change is not a slug retirement
  });

  it("refuses a plain member — renaming is owner/admin only", async () => {
    const { orgId, ownerId } = await seedTeam(`member-${randomUUID().slice(0, 6)}`);
    await expect(
      renameOrg(app, {
        orgId,
        actorRole: "member",
        actorId: ownerId,
        slug: "whatever-x",
        auditKey,
      }),
    ).rejects.toBeInstanceOf(RenameForbiddenError);
  });

  it("refuses a slug ANOTHER org retired — the never-recycle guard, surfaced as SlugTakenError", async () => {
    // Org A renames away from `contested`; org B then tries to take it. Must be refused.
    const a = await seedTeam(`contested-${randomUUID().slice(0, 6)}`);
    const contested = (await listUserOrgs(app, a.ownerId))[0]!.slug;
    await renameOrg(app, {
      orgId: a.orgId,
      actorRole: "owner",
      actorId: a.ownerId,
      slug: `moved-${randomUUID().slice(0, 6)}`,
      auditKey,
    });

    const b = await seedTeam(`bidder-${randomUUID().slice(0, 6)}`);
    await expect(
      renameOrg(app, {
        orgId: b.orgId,
        actorRole: "owner",
        actorId: b.ownerId,
        slug: contested,
        auditKey,
      }),
    ).rejects.toBeInstanceOf(SlugTakenError);
  });

  it("lets an org RECLAIM its own former slug", async () => {
    const { orgId, ownerId } = await seedTeam(`boomerang-${randomUUID().slice(0, 6)}`);
    const original = (await listUserOrgs(app, ownerId))[0]!.slug;
    await renameOrg(app, {
      orgId,
      actorRole: "owner",
      actorId: ownerId,
      slug: `away-${randomUUID().slice(0, 6)}`,
      auditKey,
    });

    const back = await renameOrg(app, {
      orgId,
      actorRole: "owner",
      actorId: ownerId,
      slug: original,
      auditKey,
    });
    expect(back.slug).toBe(original);
  });

  it("a no-op rename writes no audit row", async () => {
    const { orgId, ownerId } = await seedTeam(`noop-${randomUUID().slice(0, 6)}`);
    const current = (await listUserOrgs(app, ownerId))[0]!;

    await renameOrg(app, {
      orgId,
      actorRole: "owner",
      actorId: ownerId,
      slug: current.slug,
      name: current.name,
      auditKey,
    });

    const audit = await withTenant(
      app,
      orgId,
      (tx) => tx<{ n: number }[]>`
        select count(*)::int as n from auth_audit_event
         where org_id = ${orgId} and event_type = 'org_renamed'`,
    );
    expect(audit[0]!.n).toBe(0);
  });
});
