import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { DEV_PRINCIPAL, DEV_PRIMARY_ORG_ID, seedDevWorld } from "../src/seed";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The local-dev seeder, against a real Postgres.
//
// It has to be IDEMPOTENT, because the command that runs it (`pnpm seed`) is the one a developer re-runs
// when they are not sure what state they are in — which is exactly when a seeder that throws on second run
// is at its most useless. And it has to produce the principal `/dev-session` already hard-codes, or the
// dashboard bounces straight back to sign-in with the session it just minted.

/** First row, or a loud failure. Index access is `possibly undefined` under noUncheckedIndexedAccess, and
 *  `?.` would quietly turn "no rows" into a confusing undefined-vs-expected diff. */
function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (!row) throw new Error(`expected at least one ${what} row, got none`);
  return row;
}

let pg: EphemeralPostgres;
let app: Sql;
let identity: Sql;
let auditKey: CryptoKey;

/** A fixed hasher — the seed's ingest tokens only have to be well-formed, never secret. */
const hasher = {
  hash: (plaintext: string) => Buffer.from(`seedhash:${plaintext}`),
  candidates: (plaintext: string) => [Buffer.from(`seedhash:${plaintext}`)],
};

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  identity = createClient(pg.urlFor({ role: DB_ROLES.auth }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)),
  );
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await identity?.end();
  await pg?.stop();
});

describe("seedDevWorld", () => {
  it("creates the principal /dev-session hard-codes, so the dashboard renders", async () => {
    const world = await seedDevWorld({ app, identity, auditKey, hasher });

    expect(world.users.dev.id).toBe(DEV_PRINCIPAL.userId);
    expect(world.orgs.primary.id).toBe(DEV_PRIMARY_ORG_ID);

    // The membership is the thing every gated page re-reads (ADR-0116). Without it the session is refused.
    const rows = await withTenant(
      app,
      DEV_PRIMARY_ORG_ID,
      (tx) =>
        tx<{ role: string }[]>`
        select role from memberships
        where org_id = ${DEV_PRIMARY_ORG_ID} and user_id = ${DEV_PRINCIPAL.userId}`,
    );
    expect(rows).toHaveLength(1);
    expect(first(rows, "membership").role).toBe("owner");
  });

  it("gives every org at least one endpoint, so there is something to look at", async () => {
    const world = await seedDevWorld({ app, identity, auditKey, hasher });
    for (const org of Object.values(world.orgs)) {
      const found = world.endpoints.filter((e) => e.orgId === org.id);
      expect(found.length).toBeGreaterThan(0);
    }
  });

  it("seeds a SECOND org the dev user does not own, so isolation is visible by eye", async () => {
    const world = await seedDevWorld({ app, identity, auditKey, hasher });
    expect(world.orgs.second.id).not.toBe(world.orgs.primary.id);

    const roles = await withTenant(
      app,
      world.orgs.second.id,
      (tx) =>
        tx<{ user_id: string; role: string }[]>`
        select user_id, role from memberships where org_id = ${world.orgs.second.id} order by role`,
    );
    // The dev user is a plain MEMBER here and someone else owns it — the shape that makes a role gate and a
    // cross-tenant boundary observable without inventing a second login.
    const dev = roles.find((r) => r.user_id === DEV_PRINCIPAL.userId);
    expect(dev?.role).toBe("member");
    expect(roles.some((r) => r.role === "owner" && r.user_id !== DEV_PRINCIPAL.userId)).toBe(true);
  });

  // THE property that matters for a command a developer re-runs when confused.
  it("is idempotent — a second run returns the same world and throws nothing", async () => {
    const first = await seedDevWorld({ app, identity, auditKey, hasher });
    const second = await seedDevWorld({ app, identity, auditKey, hasher });

    expect(second.orgs.primary.id).toBe(first.orgs.primary.id);
    expect(second.orgs.second.id).toBe(first.orgs.second.id);
    expect(second.users.dev.id).toBe(first.users.dev.id);
  });

  it("does not multiply rows on repeated runs", async () => {
    await seedDevWorld({ app, identity, auditKey, hasher });
    await seedDevWorld({ app, identity, auditKey, hasher });

    // Inside the tenant context: `orgs_select` is `id = current_org_id()`, so a bare read sees nothing.
    const orgRows = await withTenant(
      app,
      DEV_PRIMARY_ORG_ID,
      (tx) =>
        tx<{ count: string }[]>`
        select count(*)::text as count from orgs where id = ${DEV_PRIMARY_ORG_ID}`,
    );
    expect(first(orgRows, "org count").count).toBe("1");

    const memberships = await withTenant(
      app,
      DEV_PRIMARY_ORG_ID,
      (tx) =>
        tx<{ count: string }[]>`
        select count(*)::text as count from memberships where org_id = ${DEV_PRIMARY_ORG_ID}`,
    );
    expect(first(memberships, "membership count").count).toBe("1");

    const endpoints = await withTenant(
      app,
      DEV_PRIMARY_ORG_ID,
      (tx) =>
        tx<{ count: string }[]>`
        select count(*)::text as count from endpoints where org_id = ${DEV_PRIMARY_ORG_ID}`,
    );
    // Re-running must not add another endpoint each time.
    const endpointCount = first(endpoints, "endpoint count").count;
    expect(Number(endpointCount)).toBeGreaterThan(0);
    const after = await seedDevWorld({ app, identity, auditKey, hasher });
    const endpoints2 = await withTenant(
      app,
      DEV_PRIMARY_ORG_ID,
      (tx) =>
        tx<{ count: string }[]>`
        select count(*)::text as count from endpoints where org_id = ${DEV_PRIMARY_ORG_ID}`,
    );
    expect(first(endpoints2, "endpoint count").count).toBe(endpointCount);
    expect(after.orgs.primary.id).toBe(DEV_PRIMARY_ORG_ID);
  });

  // The point of routing through createOrgWithOwner rather than raw inserts: the org, its owner membership
  // and this tamper-evident row commit in ONE transaction. A hand-rolled seeder could produce an org with no
  // audit trail, or worse a zero-owner orphan that RLS makes permanently unreachable.
  it("writes an org_created audit row through the real primitive, not a raw insert", async () => {
    await seedDevWorld({ app, identity, auditKey, hasher });
    const rows = await withTenant(
      app,
      DEV_PRIMARY_ORG_ID,
      (tx) =>
        tx<{ event_type: string }[]>`
        select event_type from auth_audit_event
        where org_id = ${DEV_PRIMARY_ORG_ID} and event_type = 'org_created'`,
    );
    expect(rows.length).toBe(1);
  });
});
