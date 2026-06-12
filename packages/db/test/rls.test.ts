import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Tenant-isolation leak suite (plan §0.2 "tenant-leak tests", rls-leak-tests todo).
// Runs against a REAL Postgres with REAL non-owner roles — an in-memory/superuser PG
// would bypass RLS and invalidate every assertion here. The schema owner is a
// non-superuser (test/migrate.ts), so FORCE ROW LEVEL SECURITY is meaningful and the
// owner-bypass negative control is testable.

// Every tenant-owned table and the column that carries the tenant. orgs is the root
// (keyed by id); everything else carries org_id. The catalog test (below) proves this
// list is exhaustive against the live schema, so it can't silently drift.
const TENANT_TABLES = [
  { table: "orgs", col: "id" },
  { table: "memberships", col: "org_id" },
  { table: "endpoints", col: "org_id" },
  { table: "signing_keys", col: "org_id" },
  { table: "provider_secrets", col: "org_id" },
  { table: "events", col: "org_id" },
  { table: "delivery_attempts", col: "org_id" },
  { table: "usage", col: "org_id" },
  { table: "org_limits", col: "org_id" },
  { table: "ingest_paused", col: "org_id" },
  { table: "audit_log", col: "org_id" },
] as const;

// Better Auth identity tables are GLOBAL (text ids, per-user / api-key), intentionally
// exempt from per-org RLS in this freeze (auth workstream owns any later scoping).
// schema_migrations is dbmate's bookkeeping. Documented so the catalog coverage test
// can subtract them with a reason rather than a bare skip.
const RLS_EXEMPT = new Set([
  "user",
  "session",
  "account",
  "verification",
  "apikey",
  "schema_migrations",
]);

const bytes = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + n) % 256));

interface Seeded {
  orgId: string;
  userId: string;
  endpointId: string;
  eventId: string;
}

let pg: EphemeralPostgres;
let app: Sql; // webhook_app — the request-path role
let ingest: Sql; // webhook_ingest — ingest hot-path role (events INSERT+SELECT)
let owner: Sql; // webhook_owner — schema owner (non-superuser)
let root: Sql; // cluster superuser — used only to prove trigger-level immutability
let orgA: Seeded;
let orgB: Seeded;

/** Seed one org with a row in every tenant table, written under that org's context. */
async function seedOrg(slug: string): Promise<Seeded> {
  const orgId = randomUUID();
  const userId = `user_${randomUUID()}`;
  const endpointId = randomUUID();
  const eventId = randomUUID();

  // Identity rows are global + ungranted to webhook_app, so seed as the owner.
  await owner`
    insert into "user" ("id", "name", "email", "emailVerified", "updatedAt")
    values (${userId}, ${"Seed " + slug}, ${`${slug}@example.test`}, ${true}, now())`;

  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${"Org " + slug})`;
    await tx`insert into memberships (org_id, user_id, role) values (${orgId}, ${userId}, ${"owner"})`;
    await tx`insert into endpoints (id, org_id, ingest_token_hash, name)
             values (${endpointId}, ${orgId}, ${randomBytes(32)}, ${"ep-" + slug})`;
    await tx`insert into signing_keys (id, endpoint_id, org_id, secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, envelope_version, status)
             values (${randomUUID()}, ${endpointId}, ${orgId}, ${bytes(16)}, ${bytes(16)}, ${"kek/1"}, ${bytes(12)}, ${1}, ${"active"})`;
    await tx`insert into provider_secrets (id, endpoint_id, org_id, provider, secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, envelope_version, status)
             values (${randomUUID()}, ${endpointId}, ${orgId}, ${"stripe"}, ${bytes(16)}, ${bytes(16)}, ${"kek/1"}, ${bytes(12)}, ${1}, ${"active"})`;
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${eventId}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${eventId}`}, ${128}, ${"seed-dedup"}, ${"content_hash"})`;
    await tx`insert into delivery_attempts (id, org_id, event_id, target, status)
             values (${randomUUID()}, ${orgId}, ${eventId}, ${"localhost-tunnel"}, ${"delivered"})`;
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, date_trunc('day', now()), ${1})`;
    await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${1000}, ${"pause"})`;
    await tx`insert into ingest_paused (org_id, paused) values (${orgId}, ${false})`;
    await tx`insert into audit_log (org_id, seq, actor, action, prev_hash, row_hash)
             values (${orgId}, ${1}, ${userId}, ${"org.created"}, ${null}, ${bytes(32)})`;
  });

  return { orgId, userId, endpointId, eventId };
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  ingest = createClient(pg.urlFor({ role: DB_ROLES.ingest }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  root = createClient(pg.ownerUrl);
  orgA = await seedOrg("aaa");
  orgB = await seedOrg("bbb");
}, 90_000);

afterAll(async () => {
  await app?.end();
  await ingest?.end();
  await owner?.end();
  await root?.end();
  await pg?.stop();
});

describe("cross-org isolation (every tenant table)", () => {
  for (const { table, col } of TENANT_TABLES) {
    it(`org A context cannot read org B rows in ${table}`, async () => {
      const visibleB = await withTenant(app, orgA.orgId, async (tx) => {
        const [{ n }] = await tx<{ n: number }[]>`
          select count(*)::int as n from ${tx(table)} where ${tx(col)} = ${orgB.orgId}`;
        return n;
      });
      expect(visibleB).toBe(0);
    });

    it(`no tenant context yields zero rows from ${table} (deny-by-default)`, async () => {
      const [{ n }] = await app<{ n: number }[]>`select count(*)::int as n from ${app(table)}`;
      expect(n).toBe(0);
    });
  }

  // audit_log is append-only (no UPDATE/DELETE grant or policy) — its write denial is
  // covered by the dedicated append-only describe, so exclude it from the generic
  // mutate-other-org checks (which assert 0-rows-affected, not a privilege error).
  for (const { table, col } of TENANT_TABLES.filter((t) => t.table !== "audit_log")) {
    it(`org A context cannot update org B rows in ${table}`, async () => {
      const affected = await withTenant(app, orgA.orgId, async (tx) => {
        const res =
          await tx`update ${tx(table)} set ${tx(col)} = ${tx(col)} where ${tx(col)} = ${orgB.orgId}`;
        return res.count;
      });
      expect(affected).toBe(0);
    });

    it(`org A context cannot delete org B rows in ${table}`, async () => {
      const affected = await withTenant(app, orgA.orgId, async (tx) => {
        const res = await tx`delete from ${tx(table)} where ${tx(col)} = ${orgB.orgId}`;
        return res.count;
      });
      expect(affected).toBe(0);
    });
  }

  it("org A context sees exactly its own org row, not org B's", async () => {
    const rows = await withTenant(app, orgA.orgId, async (tx) => {
      return tx<{ id: string }[]>`select id from orgs`;
    });
    expect(rows.map((r) => r.id)).toEqual([orgA.orgId]);
  });
});

describe("pooled-connection leak", () => {
  it("a returned connection carries no tenant context into the next query", async () => {
    // max:1 forces the SAME physical connection to be reused, so a leaked GUC would
    // show up. set_config(local) must auto-reset on transaction return.
    const single = createClient(pg.urlFor({ role: DB_ROLES.app }), { max: 1 });
    try {
      const seen = await withTenant(single, orgA.orgId, async (tx) => {
        const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from events`;
        return n;
      });
      expect(seen).toBe(1); // sees its own org inside the context

      const [{ n }] = await single<{ n: number }[]>`select count(*)::int as n from events`;
      expect(n).toBe(0); // no leak after the transaction returned the connection
    } finally {
      await single.end();
    }
  });
});

describe("owner / FORCE RLS negative control", () => {
  it("the table owner with no context is still denied reads (FORCE row level security)", async () => {
    // Without FORCE RLS the owner would bypass policies and see ALL orgs' rows. This
    // is the regression guard for a missing FORCE / an owner connection on the path.
    const [{ n }] = await owner<{ n: number }[]>`select count(*)::int as n from events`;
    expect(n).toBe(0);
  });

  it("the table owner is not a superuser and cannot bypass RLS", async () => {
    const [{ super: isSuper, bypass }] = await owner<{ super: boolean; bypass: boolean }[]>`
      select rolsuper as super, rolbypassrls as bypass from pg_roles where rolname = ${DB_ROLES.owner}`;
    expect(isSuper).toBe(false);
    expect(bypass).toBe(false);
  });

  it("the owner with context is still policed to that single org", async () => {
    const rows = await withTenant(owner, orgB.orgId, async (tx) => {
      return tx<{ id: string }[]>`select id from orgs`;
    });
    expect(rows.map((r) => r.id)).toEqual([orgB.orgId]);
  });
});

describe("ingest_event() single-statement hot path", () => {
  it("inserts under server-derived org context and stamps received_at server-side", async () => {
    const id = randomUUID();
    const before = Date.now();
    const rows = await ingest<{ event_id: string; inserted: boolean }[]>`
      select * from ingest_event(
        ${id}::uuid, ${orgA.orgId}::uuid, ${orgA.endpointId}::uuid,
        ${`org/${orgA.orgId}/ep/${orgA.endpointId}/${id}`}, ${64}::bigint,
        ${"ingest-dedup-1"}, ${"sw_webhook_id"}
      )`;
    expect(rows[0]?.inserted).toBe(true);
    expect(rows[0]?.event_id).toBe(id);

    const [evt] = await withTenant(app, orgA.orgId, async (tx) => {
      return tx<{ received_at: Date }[]>`select received_at from events where id = ${id}`;
    });
    expect(evt.received_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(evt.received_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("dedups on (endpoint_id, dedup_key): a repeat is a no-op success", async () => {
    const call = () =>
      ingest<{ inserted: boolean }[]>`
        select * from ingest_event(
          ${randomUUID()}::uuid, ${orgA.orgId}::uuid, ${orgA.endpointId}::uuid,
          ${"r2key"}, ${64}::bigint, ${"ingest-dedup-2"}, ${"sw_webhook_id"}
        )`;
    const first = await call();
    const second = await call();
    expect(first[0]?.inserted).toBe(true);
    expect(second[0]?.inserted).toBe(false);
  });

  it("the ingest role is RLS-enforced: no rows without a tenant context", async () => {
    // webhook_ingest holds SELECT on events (required by ON CONFLICT's arbiter) but is
    // a non-owner, RLS-enforced role — so a context-less read still returns nothing,
    // and it can only ever see its own org's rows.
    const [{ n }] = await ingest<{ n: number }[]>`select count(*)::int as n from events`;
    expect(n).toBe(0);
    const scoped = await withTenant(ingest, orgB.orgId, async (tx) => {
      const [{ m }] = await tx<{ m: number }[]>`
        select count(*)::int as m from events where org_id = ${orgA.orgId}`;
      return m;
    });
    expect(scoped).toBe(0);
  });

  it("the ingest role cannot touch any other tenant table", async () => {
    await expect(ingest`select * from orgs limit 1`).rejects.toThrow(/permission denied/i);
  });

  it("the ingest role has a bounded statement_timeout (H5 watermark invariant)", async () => {
    const [{ cfg }] = await owner<{ cfg: string[] | null }[]>`
      select rolconfig as cfg from pg_roles where rolname = ${DB_ROLES.ingest}`;
    expect(cfg ?? []).toContain("statement_timeout=5s");
  });
});

describe("composite org-binding FK (defense-in-depth on RLS)", () => {
  it("rejects an event whose endpoint belongs to a different org", async () => {
    // In org A's context, reference org B's endpoint with org_id = A. The composite
    // (endpoint_id, org_id) FK to endpoints(id, org_id) makes this fail closed even
    // though RLS's insert WITH CHECK (org_id = A) would otherwise pass.
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
                 values (${randomUUID()}, ${orgA.orgId}, ${orgB.endpointId}, ${"x"}, ${1}, ${"xorg"}, ${"content_hash"})`;
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("audit_log append-only hash chain (H2)", () => {
  it("enforces contiguous per-org seq starting at 1", async () => {
    await withTenant(app, orgA.orgId, async (tx) => {
      // org A already has seq 1 (seeded). seq 2 with the right link is accepted.
      await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
               values (${orgA.orgId}, ${2}, ${"endpoint.created"}, ${bytes(32)}, ${bytes(33)})`;
    });
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
                 values (${orgA.orgId}, ${5}, ${"gap"}, ${bytes(33)}, ${bytes(34)})`;
      }),
    ).rejects.toThrow(/contiguous/i);
  });

  it("rejects a contiguous row whose prev_hash does not match the prior row_hash", async () => {
    // Self-contained chain on a fresh org: genesis (seq 1) then seq 2 with a WRONG
    // prev_hash — the core tamper guard (must equal the prior row_hash).
    const chainOrg = randomUUID();
    await withTenant(app, chainOrg, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${chainOrg}, ${"chainx"}, ${"Chain"})`;
      await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
               values (${chainOrg}, ${1}, ${"org.created"}, ${null}, ${bytes(40)})`;
    });
    await expect(
      withTenant(app, chainOrg, async (tx) => {
        await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
                 values (${chainOrg}, ${2}, ${"endpoint.created"}, ${bytes(41)}, ${bytes(42)})`;
      }),
    ).rejects.toThrow(/prev_hash must equal/i);
  });

  it("rejects a genesis row with a non-null prev_hash", async () => {
    const freshOrg = randomUUID();
    await expect(
      withTenant(app, freshOrg, async (tx) => {
        await tx`insert into orgs (id, slug, name) values (${freshOrg}, ${"genx"}, ${"Gen"})`;
        await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
                 values (${freshOrg}, ${1}, ${"x"}, ${bytes(32)}, ${bytes(33)})`;
      }),
    ).rejects.toThrow(/genesis/i);
  });

  it("withholds UPDATE/DELETE privilege from the app role (privilege layer)", async () => {
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`update audit_log set action = ${"tampered"} where org_id = ${orgA.orgId} and seq = ${1}`;
      }),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`delete from audit_log where org_id = ${orgA.orgId} and seq = ${1}`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("the immutability trigger blocks UPDATE/DELETE/TRUNCATE even for a superuser", async () => {
    // The trigger is the last line of defense: even a role that bypasses RLS and has
    // every privilege (the cluster superuser) cannot rewrite history.
    await expect(
      root`update audit_log set action = ${"tampered"} where org_id = ${orgA.orgId} and seq = ${1}`,
    ).rejects.toThrow(/append-only/i);
    await expect(
      root`delete from audit_log where org_id = ${orgA.orgId} and seq = ${1}`,
    ).rejects.toThrow(/append-only/i);
    await expect(root`truncate audit_log`).rejects.toThrow(/append-only/i);
  });
});

describe("catalog-driven RLS coverage (M3)", () => {
  it("every non-exempt base table has RLS enabled and forced", async () => {
    const tables = await owner<{ relname: string; rls: boolean; force: boolean }[]>`
      select relname, relrowsecurity as rls, relforcerowsecurity as force
      from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace`;
    const offenders = tables
      .filter((t) => !RLS_EXEMPT.has(t.relname))
      .filter((t) => !t.rls || !t.force)
      .map((t) => t.relname);
    expect(offenders).toEqual([]);
  });

  it("the TENANT_TABLES list matches the live set of RLS-protected tables", async () => {
    const tables = await owner<{ relname: string }[]>`
      select relname from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and relrowsecurity and relforcerowsecurity`;
    const live = tables.map((t) => t.relname).sort();
    const declared = TENANT_TABLES.map((t) => t.table).sort();
    expect(declared).toEqual(live);
  });

  it("every RLS table has policies for all four commands", async () => {
    const rows = await owner<{ tablename: string; cmd: string }[]>`
      select tablename, cmd from pg_policies where schemaname = 'public'`;
    for (const { table } of TENANT_TABLES) {
      const cmds = new Set(rows.filter((r) => r.tablename === table).map((r) => r.cmd));
      // audit_log is deliberately INSERT+SELECT only (no UPDATE/DELETE policy).
      const expected =
        table === "audit_log" ? ["INSERT", "SELECT"] : ["DELETE", "INSERT", "SELECT", "UPDATE"];
      expect([...cmds].sort()).toEqual(expected);
    }
  });

  it("the app and ingest roles are non-owner, non-superuser, no BYPASSRLS", async () => {
    const roles = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname in (${DB_ROLES.app}, ${DB_ROLES.ingest})`;
    expect(roles).toHaveLength(2);
    for (const r of roles) {
      expect(r.super).toBe(false);
      expect(r.bypass).toBe(false);
    }
    // None of the tenant tables are owned by the app/ingest roles.
    const ownedByApp = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) in (${DB_ROLES.app}, ${DB_ROLES.ingest})`;
    expect(ownedByApp[0]?.n).toBe(0);
  });
});

describe("no unexpected SECURITY DEFINER functions (M2)", () => {
  it("has zero SECURITY DEFINER functions in the public schema", async () => {
    // The freeze intentionally ships no SECURITY DEFINER routine (all helpers are
    // INVOKER, so RLS is never silently bypassed). If a future migration adds one, it
    // must be reviewed and allowlisted here with a documented reason.
    const definers = await owner<{ proname: string }[]>`
      select proname from pg_proc
      where pronamespace = 'public'::regnamespace and prosecdef`;
    expect(definers.map((d) => d.proname)).toEqual([]);
  });
});
