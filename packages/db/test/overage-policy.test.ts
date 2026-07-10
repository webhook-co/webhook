import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setOverageEnabled } from "../src/overage-policy";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// setOverageEnabled: an owner/admin-only, audited flip of org_limits.pause_policy ('allow' = overage on).
// The gate + update + audit are one tenant transaction — an unauthorized caller writes nothing, and a real
// flip always carries its audit row. Idempotent (no-op when already at the target). Free orgs (no
// org_limits row) cannot opt in.

let pg: EphemeralPostgres;
let app: Sql;
let admin: Sql;
let key: CryptoKey;

async function seedUser(id: string): Promise<void> {
  await admin`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${id}, ${id}, ${`${id}@example.test`}, ${true}, now())`;
}

/** Seed an org + a membership for `userId` at `role` + (optionally) an org_limits row with `policy`. */
async function seedOrg(
  userId: string,
  role: "owner" | "admin" | "member",
  opts: { policy?: "pause" | "allow" | null } = {},
): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"o"})`;
    await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${role})`;
    if (opts.policy !== null && opts.policy !== undefined) {
      await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${1000}, ${opts.policy})`;
    }
  });
  return orgId;
}

async function policyOf(orgId: string): Promise<string | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ pause_policy: string }[]>`select pause_policy from org_limits`;
    return row?.pause_policy ?? null;
  });
}

async function auditActions(orgId: string): Promise<string[]> {
  const rows = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  admin = createClient(pg.ownerUrl);
  key = await importAuditKey(Buffer.alloc(32, 0x5c));
}, setupHookTimeoutMs());

// No beforeEach cleanup: every test uses fresh random org/user ids, so rows never collide, and audit_log is
// append-only (DELETE is trigger-blocked) — assertions are all per-orgId, so accumulation is harmless.

afterAll(async () => {
  await app?.end();
  await admin?.end();
  await pg?.stop();
});

describe("setOverageEnabled", () => {
  it("an OWNER enabling overage flips pause_policy → 'allow' and appends a policy_changed audit", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "owner", { policy: "pause" });

    const res = await setOverageEnabled(app, key, { orgId, userId: u, enabled: true });

    expect(res).toEqual({ status: "ok", policy: "allow", changed: true });
    expect(await policyOf(orgId)).toBe("allow");
    expect(await auditActions(orgId)).toContain("policy_changed");
  });

  it("an ADMIN disabling overage flips 'allow' → 'pause' (changed)", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "admin", { policy: "allow" });

    const res = await setOverageEnabled(app, key, { orgId, userId: u, enabled: false });

    expect(res).toEqual({ status: "ok", policy: "pause", changed: true });
    expect(await policyOf(orgId)).toBe("pause");
  });

  it("is idempotent — setting the CURRENT value writes nothing (changed:false, no new audit row)", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "owner", { policy: "allow" });

    const res = await setOverageEnabled(app, key, { orgId, userId: u, enabled: true }); // already 'allow'

    expect(res).toEqual({ status: "ok", policy: "allow", changed: false });
    expect(await auditActions(orgId)).toEqual([]); // no policy_changed row for a no-op
  });

  it("a plain MEMBER is forbidden — no write, no audit (SEC-RLS-08)", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "member", { policy: "pause" });

    const res = await setOverageEnabled(app, key, { orgId, userId: u, enabled: true });

    expect(res).toEqual({ status: "forbidden" });
    expect(await policyOf(orgId)).toBe("pause"); // unchanged
    expect(await auditActions(orgId)).toEqual([]);
  });

  it("a non-member (no membership row) is forbidden", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    const ghost = `ghost_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    await seedUser(ghost);
    const orgId = await seedOrg(u, "owner", { policy: "pause" });

    const res = await setOverageEnabled(app, key, { orgId, userId: ghost, enabled: true });

    expect(res).toEqual({ status: "forbidden" });
    expect(await policyOf(orgId)).toBe("pause");
  });

  it("a Free org (no org_limits row) cannot opt in → no_subscription", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "owner", { policy: null }); // no org_limits row

    const res = await setOverageEnabled(app, key, { orgId, userId: u, enabled: true });

    expect(res).toEqual({ status: "no_subscription" });
    expect(await policyOf(orgId)).toBeNull();
  });

  it("is tenant-isolated — an owner of org B cannot flip org A (RLS scopes the membership read)", async () => {
    const uA = `ua_${randomUUID().slice(0, 8)}`;
    const uB = `ub_${randomUUID().slice(0, 8)}`;
    await seedUser(uA);
    await seedUser(uB);
    const orgA = await seedOrg(uA, "owner", { policy: "pause" }); // uA owns org A
    await seedOrg(uB, "owner", { policy: "pause" }); // uB owns org B, not org A

    // Calling for orgA with uB: withTenant pins RLS to orgA, so uB's (org B) membership is invisible → forbidden.
    const res = await setOverageEnabled(app, key, { orgId: orgA, userId: uB, enabled: true });

    expect(res).toEqual({ status: "forbidden" });
    expect(await policyOf(orgA)).toBe("pause");
  });
});
