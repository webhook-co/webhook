import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { pruneAllExpiredAuthTokens } from "../src/sweep";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Cross-org expiry cron-sweep (migration 0020, ADR cron-sweep). The webhook_sweeper role is a
// least-privilege, NON-OWNER, NOSUPERUSER, NOBYPASSRLS control-plane housekeeping role: DELETE-only on
// auth_refresh_token + auth_session_exchange, with role-targeted permissive DELETE policies that scope to
// `expires_at < now()` ACROSS ALL ORGS. It runs no tenant GUC and reads NO row data — the policy alone
// bounds the bare DELETE to expired rows. Contrast the on-access per-org sweep (sweepExpiredRefreshTokens
// / sweepExpiredSessionExchanges): that prunes only the CONSUMING org under webhook_app's org-scoped DELETE
// policy, so a fully-churned/abandoned org never gets swept — which is exactly what this cron covers.
//
// Runs against a REAL Postgres with REAL non-owner roles (an in-memory/superuser PG would bypass RLS and
// invalidate every assertion). The schema owner is a non-superuser (test/migrate.ts), so FORCE RLS is
// meaningful and the no-read / role-targeted-policy guarantees are testable.

const API = "https://api.webhook.co";
const APP = "https://app.webhook.co";

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — the OWNER pool for seeding (the sweeper can't insert/read)
let owner: Sql; // webhook_owner — seeds the global `user` rows (ungranted to webhook_app)
let sweeper: Sql; // webhook_sweeper — the cross-org DELETE-only cron role under test

function userOf(orgId: string): string {
  return `u_${orgId.slice(0, 8)}`;
}

/** Seed an org (+ its global user + a grant for the refresh-token FK), under that org's RLS context. */
async function seedOrg(orgId: string): Promise<string> {
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${userOf(orgId)}, ${"Seed"}, ${`${orgId.slice(0, 8)}@e.test`}, ${true}, now())`;
  const grantId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${orgId.slice(0, 8)}, ${"Org"})`;
    await tx`insert into auth_grant (id, org_id, user_id, status, auth_method)
             values (${grantId}, ${orgId}, ${userOf(orgId)}, ${"active"}, ${"pkce_loopback"})`;
  });
  return grantId;
}

/**
 * Insert one refresh handle (the on-access mints can't produce a past expiry without -ttl, and the cron
 * must prune rows no consume will ever revisit). `pastDue` controls whether it's already expired.
 */
async function seedRefreshToken(orgId: string, grantId: string, pastDue: boolean): Promise<Buffer> {
  const hash = randomBytes(32);
  const expiry = pastDue ? "now() - interval '1 hour'" : "now() + interval '90 days'";
  await withTenant(app, orgId, (tx) =>
    tx.unsafe(
      `insert into auth_refresh_token
           (id, org_id, grant_id, audience, token_hash, prefix, start, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, ${expiry})`,
      [randomUUID(), orgId, grantId, API, hash, "rtk", "rtk_seed"],
    ),
  );
  return hash;
}

/** Insert one session-exchange ticket (no grant FK — just org + user). */
async function seedSessionExchange(orgId: string, pastDue: boolean): Promise<Buffer> {
  const hash = randomBytes(32);
  const expiry = pastDue ? "now() - interval '1 hour'" : "now() + interval '5 minutes'";
  await withTenant(app, orgId, (tx) =>
    tx.unsafe(
      `insert into auth_session_exchange
           (id, org_id, user_id, audience, token_hash, prefix, start, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, ${expiry})`,
      [randomUUID(), orgId, userOf(orgId), APP, hash, "sxt", "sxt_seed"],
    ),
  );
  return hash;
}

async function refreshTokenExists(orgId: string, tokenHash: Buffer): Promise<boolean> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ n: number }[]>`select 1 as n from auth_refresh_token where token_hash = ${tokenHash}`,
  );
  return row !== undefined;
}

async function sessionExchangeExists(orgId: string, tokenHash: Buffer): Promise<boolean> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ n: number }[]>`select 1 as n from auth_session_exchange where token_hash = ${tokenHash}`,
  );
  return row !== undefined;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  sweeper = createClient(pg.urlFor({ role: DB_ROLES.sweeper }));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await sweeper?.end();
  await pg?.stop();
});

describe("pruneAllExpiredAuthTokens (cross-org cron sweep)", () => {
  it("deletes ALL expired rows from BOTH tables across BOTH orgs, keeping unexpired rows", async () => {
    // Two distinct orgs, each with one expired + one unexpired row in each table.
    const orgA = randomUUID();
    const orgB = randomUUID();
    const grantA = await seedOrg(orgA);
    const grantB = await seedOrg(orgB);

    const expiredRtA = await seedRefreshToken(orgA, grantA, true);
    const freshRtA = await seedRefreshToken(orgA, grantA, false);
    const expiredRtB = await seedRefreshToken(orgB, grantB, true);
    const freshRtB = await seedRefreshToken(orgB, grantB, false);

    const expiredSxA = await seedSessionExchange(orgA, true);
    const freshSxA = await seedSessionExchange(orgA, false);
    const expiredSxB = await seedSessionExchange(orgB, true);
    const freshSxB = await seedSessionExchange(orgB, false);

    const counts = await pruneAllExpiredAuthTokens(sweeper);

    // Exactly the four expired rows (2 orgs × 1 each) per table are removed.
    expect(counts).toEqual({ refreshTokens: 2, sessionExchanges: 2 });

    // The expired rows from BOTH orgs are gone…
    expect(await refreshTokenExists(orgA, expiredRtA)).toBe(false);
    expect(await refreshTokenExists(orgB, expiredRtB)).toBe(false);
    expect(await sessionExchangeExists(orgA, expiredSxA)).toBe(false);
    expect(await sessionExchangeExists(orgB, expiredSxB)).toBe(false);

    // …and every unexpired row survives.
    expect(await refreshTokenExists(orgA, freshRtA)).toBe(true);
    expect(await refreshTokenExists(orgB, freshRtB)).toBe(true);
    expect(await sessionExchangeExists(orgA, freshSxA)).toBe(true);
    expect(await sessionExchangeExists(orgB, freshSxB)).toBe(true);
  });

  it("is a no-op (counts 0) when nothing is expired", async () => {
    const org = randomUUID();
    const grant = await seedOrg(org);
    await seedRefreshToken(org, grant, false);
    await seedSessionExchange(org, false);

    const counts = await pruneAllExpiredAuthTokens(sweeper);
    expect(counts).toEqual({ refreshTokens: 0, sessionExchanges: 0 });
  });
});

describe("webhook_sweeper least privilege", () => {
  it("CANNOT select from either table (DELETE-only, never reads row data)", async () => {
    await expect(sweeper`select * from auth_refresh_token limit 1`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(sweeper`select * from auth_session_exchange limit 1`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("CANNOT insert into either table", async () => {
    await expect(
      sweeper`insert into auth_refresh_token
                (id, org_id, grant_id, audience, token_hash, prefix, start, expires_at)
              values (${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${API},
                      ${randomBytes(32)}, ${"rtk"}, ${"x"}, now())`,
    ).rejects.toThrow(/permission denied/i);
    await expect(
      sweeper`insert into auth_session_exchange
                (id, org_id, user_id, audience, token_hash, prefix, start, expires_at)
              values (${randomUUID()}, ${randomUUID()}, ${"u"}, ${APP},
                      ${randomBytes(32)}, ${"sxt"}, ${"x"}, now())`,
    ).rejects.toThrow(/permission denied/i);
  });

  it("CANNOT update either table", async () => {
    await expect(sweeper`update auth_refresh_token set used_at = now()`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(sweeper`update auth_session_exchange set used_at = now()`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("a bare DELETE leaves unexpired rows untouched (the policy scopes to expires_at < now())", async () => {
    const org = randomUUID();
    const grant = await seedOrg(org);
    const fresh = await seedRefreshToken(org, grant, false);
    const freshSx = await seedSessionExchange(org, false);

    // The sweeper issues bare deletes; the role-targeted policy's USING (expires_at < now()) is the only
    // gate, so an unexpired row is simply invisible to the DELETE and survives.
    await pruneAllExpiredAuthTokens(sweeper);

    expect(await refreshTokenExists(org, fresh)).toBe(true);
    expect(await sessionExchangeExists(org, freshSx)).toBe(true);
  });

  it("is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.sweeper}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const owned = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.sweeper}`;
    expect(owned[0]?.n).toBe(0);
  });

  it("holds DELETE — and ONLY delete — on the two token tables, nothing on other tenant tables", async () => {
    const tables = ["auth_refresh_token", "auth_session_exchange"] as const;
    for (const t of tables) {
      const [p] = await owner<{ s: boolean; i: boolean; u: boolean; d: boolean }[]>`
        select has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'SELECT') as s,
               has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'INSERT') as i,
               has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'UPDATE') as u,
               has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'DELETE') as d`;
      expect([p.s, p.i, p.u, p.d]).toEqual([false, false, false, true]);
    }
    // No privilege on any other tenant table.
    const forbidden = ["orgs", "api_keys", "events", "audit_log", "auth_grant"] as const;
    for (const t of forbidden) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'SELECT')
             or has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
  });
});
