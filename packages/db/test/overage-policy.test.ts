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

const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00Z → UTC period [2026-07-01, 2026-08-01)
const IN_PERIOD = "2026-07-10T00:00:00.000Z";

let pg: EphemeralPostgres;
let app: Sql;
let admin: Sql;
let key: CryptoKey;

/** Seed rolled usage in NOW's period so evaluateOrgCap (inside setOverageEnabled) sees the org over cap. */
async function seedUsage(orgId: string, count: number): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, ${IN_PERIOD}, ${count})`;
  });
}

async function pausedOf(orgId: string): Promise<boolean | null> {
  return withTenant(app, orgId, async (tx) => {
    const [row] = await tx<{ paused: boolean }[]>`select paused from ingest_paused`;
    return row?.paused ?? null;
  });
}

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
    // created_at anchors the lifetime allowance window; set it BEFORE the seeded usage date so
    // sumPeriodEventUsage (inside evaluateOrgCap) counts it (else the window excludes it → never over cap).
    await tx`insert into orgs (id, slug, name, created_at) values (${orgId}, ${orgId.slice(0, 8)}, ${"o"}, ${"2026-01-01T00:00:00.000Z"})`;
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

    const res = await setOverageEnabled(app, key, {
      orgId,
      userId: u,
      enabled: true,
      now: NOW,
      defaultEventCap: null,
    });

    expect(res).toEqual({ status: "ok", policy: "allow", changed: true, transitioned: false });
    expect(await policyOf(orgId)).toBe("allow");
    expect(await auditActions(orgId)).toContain("policy_changed");
  });

  it("an ADMIN disabling overage flips 'allow' → 'pause' (changed)", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "admin", { policy: "allow" });

    const res = await setOverageEnabled(app, key, {
      orgId,
      userId: u,
      enabled: false,
      now: NOW,
      defaultEventCap: null,
    });

    expect(res).toEqual({ status: "ok", policy: "pause", changed: true, transitioned: false });
    expect(await policyOf(orgId)).toBe("pause");
  });

  it("is idempotent — setting the CURRENT value writes nothing (changed:false, no new audit row)", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "owner", { policy: "allow" });

    const res = await setOverageEnabled(app, key, {
      orgId,
      userId: u,
      enabled: true,
      now: NOW,
      defaultEventCap: null,
    }); // already 'allow'

    expect(res).toEqual({ status: "ok", policy: "allow", changed: false, transitioned: false });
    expect(await auditActions(orgId)).toEqual([]); // no policy_changed row for a no-op
  });

  it("a plain MEMBER is forbidden — no write, no audit (SEC-RLS-08)", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "member", { policy: "pause" });

    const res = await setOverageEnabled(app, key, {
      orgId,
      userId: u,
      enabled: true,
      now: NOW,
      defaultEventCap: null,
    });

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

    const res = await setOverageEnabled(app, key, {
      orgId,
      userId: ghost,
      enabled: true,
      now: NOW,
      defaultEventCap: null,
    });

    expect(res).toEqual({ status: "forbidden" });
    expect(await policyOf(orgId)).toBe("pause");
  });

  it("a Free org (no org_limits row) cannot opt in → no_subscription", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "owner", { policy: null }); // no org_limits row

    const res = await setOverageEnabled(app, key, {
      orgId,
      userId: u,
      enabled: true,
      now: NOW,
      defaultEventCap: null,
    });

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
    const res = await setOverageEnabled(app, key, {
      orgId: orgA,
      userId: uB,
      enabled: true,
      now: NOW,
      defaultEventCap: null,
    });

    expect(res).toEqual({ status: "forbidden" });
    expect(await policyOf(orgA)).toBe("pause");
  });

  it("durably PAUSES an over-cap org when overage is turned OFF (ingest_paused flips in the SAME tx)", async () => {
    // The money-correctness guarantee: enforcement is reconciled durably here, not left to the cron. An org
    // over its cap on 'allow' (overage on, unpaused) that turns overage off must be paused immediately.
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "owner", { policy: "allow" });
    await seedUsage(orgId, 1500); // > event_cap (1000)

    const res = await setOverageEnabled(app, key, {
      orgId,
      userId: u,
      enabled: false,
      now: NOW,
      defaultEventCap: null,
    });

    expect(res).toEqual({ status: "ok", policy: "pause", changed: true, transitioned: true });
    expect(await pausedOf(orgId)).toBe(true); // durable — no cron pass needed
  });

  it("durably RESUMES an over-cap paused org when overage is turned ON", async () => {
    const u = `u_${randomUUID().slice(0, 8)}`;
    await seedUser(u);
    const orgId = await seedOrg(u, "owner", { policy: "pause" });
    await seedUsage(orgId, 1500);
    // Start paused (as the cron would have left it while overage was off + over cap).
    await withTenant(app, orgId, async (tx) => {
      await tx`insert into ingest_paused (org_id, paused, reason, since) values (${orgId}, ${true}, ${"cap"}, now())`;
    });

    const res = await setOverageEnabled(app, key, {
      orgId,
      userId: u,
      enabled: true,
      now: NOW,
      defaultEventCap: null,
    });

    expect(res).toEqual({ status: "ok", policy: "allow", changed: true, transitioned: true });
    expect(await pausedOf(orgId)).toBe(false); // resumed durably
  });
});
