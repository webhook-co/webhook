import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// Tenant-isolation leak suite (the "tenant-leak tests", rls-leak-tests todo).
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
  { table: "replay_destinations", col: "org_id" },
  { table: "events", col: "org_id" },
  { table: "delivery_attempts", col: "org_id" },
  { table: "usage", col: "org_id" },
  { table: "org_limits", col: "org_id" },
  { table: "ingest_paused", col: "org_id" },
  { table: "audit_log", col: "org_id" },
  { table: "api_keys", col: "org_id" },
  { table: "auth_grant", col: "org_id" },
  { table: "auth_refresh_token", col: "org_id" },
  { table: "auth_session_exchange", col: "org_id" },
  { table: "org_policy", col: "org_id" },
  { table: "auth_audit_event", col: "org_id" },
] as const;

// Better Auth identity tables are GLOBAL (text ids, per-user / api-key), intentionally
// exempt from per-org RLS here (the auth layer owns any later scoping).
// schema_migrations is dbmate's bookkeeping. Documented so the catalog coverage test
// can subtract them with a reason rather than a bare skip.
//
// `apikey` is the better-auth plugin's table and STAYS exempt here per ADR-0008
// (Option B): our own RLS+FORCE `api_keys` table (in TENANT_TABLES) is the new
// org-scoped store, but the plugin's `apikey` exemption is removed only in a LATER
// contract migration once nothing reads it — never in this release.
const RLS_EXEMPT = new Set([
  "user",
  "session",
  "account",
  "verification",
  "apikey",
  "schema_migrations",
]);

// Deterministic, seed-by-length Buffer for fixture bytea values (NOT random — stable
// across runs so failures are reproducible). Name says what it is and what it returns.
const deterministicBuffer = (n: number) =>
  Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + n) % 256));

// Tolerance for server-stamped timestamp assertions: covers DB round-trip, scheduler
// delay, and minor clock jitter between the test clock and the server clock.
const TIMESTAMP_TOLERANCE_MS = 1_000;

// The ingest role's bounded statement_timeout (watermark invariant). Authoritative
// value lives in migration 0006_ingest_event.sql (`alter role webhook_ingest set
// statement_timeout`) and the shared INGEST_STATEMENT_TIMEOUT_MS = 5_000; this string
// must stay in lockstep with both.
const INGEST_ROLE_STATEMENT_TIMEOUT = "5s";

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
let anchor: Sql; // webhook_anchor — WORM head-anchor cross-org chain-head reader
let sweeper: Sql; // webhook_sweeper — cross-org expiry cron-sweep (DELETE-only on the two token tables)
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
             values (${randomUUID()}, ${endpointId}, ${orgId}, ${deterministicBuffer(16)}, ${deterministicBuffer(16)}, ${"kek/1"}, ${deterministicBuffer(12)}, ${1}, ${"active"})`;
    await tx`insert into provider_secrets (id, endpoint_id, org_id, provider, secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, envelope_version, status)
             values (${randomUUID()}, ${endpointId}, ${orgId}, ${"stripe"}, ${deterministicBuffer(16)}, ${deterministicBuffer(16)}, ${"kek/1"}, ${deterministicBuffer(12)}, ${1}, ${"active"})`;
    await tx`insert into replay_destinations (id, org_id, url)
             values (${randomUUID()}, ${orgId}, ${`https://hooks-${slug}.example.com/in`})`;
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${eventId}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${eventId}`}, ${128}, ${"seed-dedup"}, ${"content_hash"})`;
    await tx`insert into delivery_attempts (id, org_id, event_id, target, status)
             values (${randomUUID()}, ${orgId}, ${eventId}, ${"localhost-tunnel"}, ${"delivered"})`;
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, date_trunc('day', now()), ${1})`;
    await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${1000}, ${"pause"})`;
    await tx`insert into ingest_paused (org_id, paused) values (${orgId}, ${false})`;
    // Genesis row: prev_hash is omitted (defaults to NULL) — a genesis row has no prior.
    await tx`insert into audit_log (org_id, seq, actor, action, row_hash)
             values (${orgId}, ${1}, ${userId}, ${"org.created"}, ${deterministicBuffer(32)})`;
    await tx`insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes)
             values (${randomUUID()}, ${orgId}, ${randomBytes(32)}, ${"whk"}, ${"whk_" + slug}, ${"key-" + slug}, ${tx.json(["events:read"])})`;
    await tx`insert into auth_grant (id, org_id, user_id, status, auth_method)
             values (${randomUUID()}, ${orgId}, ${userId}, ${"active"}, ${"pkce_loopback"})`;
    await tx`insert into org_policy (org_id) values (${orgId})`;
    // Genesis row of the control-plane auth chain (prev_hash omitted = NULL genesis).
    await tx`insert into auth_audit_event (org_id, seq, actor, event_type, row_hash)
             values (${orgId}, ${1}, ${userId}, ${"grant_created"}, ${deterministicBuffer(32)})`;
  });

  return { orgId, userId, endpointId, eventId };
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  ingest = createClient(pg.urlFor({ role: DB_ROLES.ingest }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  anchor = createClient(pg.urlFor({ role: DB_ROLES.anchor }));
  sweeper = createClient(pg.urlFor({ role: DB_ROLES.sweeper }));
  root = createClient(pg.ownerUrl);
  orgA = await seedOrg("aaa");
  orgB = await seedOrg("bbb");
}, 90_000);

afterAll(async () => {
  await app?.end();
  await ingest?.end();
  await owner?.end();
  await anchor?.end();
  await sweeper?.end();
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

  // audit_log + auth_audit_event are append-only (no UPDATE/DELETE grant or policy) — their
  // write denial is covered by the dedicated append-only describes, so exclude them from the
  // generic mutate-other-org checks (which assert 0-rows-affected, not a privilege error).
  for (const { table, col } of TENANT_TABLES.filter(
    (t) => t.table !== "audit_log" && t.table !== "auth_audit_event",
  )) {
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
    expect(evt.received_at.getTime()).toBeGreaterThanOrEqual(before - TIMESTAMP_TOLERANCE_MS);
    expect(evt.received_at.getTime()).toBeLessThanOrEqual(Date.now() + TIMESTAMP_TOLERANCE_MS);
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

  it("the ingest role has a bounded statement_timeout (watermark invariant)", async () => {
    const [{ cfg }] = await owner<{ cfg: string[] | null }[]>`
      select rolconfig as cfg from pg_roles where rolname = ${DB_ROLES.ingest}`;
    expect(cfg ?? []).toContain(`statement_timeout=${INGEST_ROLE_STATEMENT_TIMEOUT}`);
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

describe("audit_log append-only hash chain", () => {
  it("enforces contiguous per-org seq starting at 1", async () => {
    await withTenant(app, orgA.orgId, async (tx) => {
      // org A already has seq 1 (seeded). seq 2 with the right link is accepted.
      await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
               values (${orgA.orgId}, ${2}, ${"endpoint.created"}, ${deterministicBuffer(32)}, ${deterministicBuffer(33)})`;
    });
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
                 values (${orgA.orgId}, ${5}, ${"gap"}, ${deterministicBuffer(33)}, ${deterministicBuffer(34)})`;
      }),
    ).rejects.toThrow(/contiguous/i);
  });

  it("rejects a contiguous row whose prev_hash does not match the prior row_hash", async () => {
    // Self-contained chain on a fresh org: genesis (seq 1) then seq 2 with a WRONG
    // prev_hash — the core tamper guard (must equal the prior row_hash).
    const chainOrg = randomUUID();
    await withTenant(app, chainOrg, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${chainOrg}, ${"chainx"}, ${"Chain"})`;
      // Genesis row: prev_hash omitted (defaults to NULL).
      await tx`insert into audit_log (org_id, seq, action, row_hash)
               values (${chainOrg}, ${1}, ${"org.created"}, ${deterministicBuffer(40)})`;
    });
    await expect(
      withTenant(app, chainOrg, async (tx) => {
        await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
                 values (${chainOrg}, ${2}, ${"endpoint.created"}, ${deterministicBuffer(41)}, ${deterministicBuffer(42)})`;
      }),
    ).rejects.toThrow(/prev_hash must equal/i);
  });

  it("rejects a genesis row with a non-null prev_hash", async () => {
    const freshOrg = randomUUID();
    await expect(
      withTenant(app, freshOrg, async (tx) => {
        await tx`insert into orgs (id, slug, name) values (${freshOrg}, ${"genx"}, ${"Gen"})`;
        await tx`insert into audit_log (org_id, seq, action, prev_hash, row_hash)
                 values (${freshOrg}, ${1}, ${"x"}, ${deterministicBuffer(32)}, ${deterministicBuffer(33)})`;
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

  it("the immutability trigger blocks UPDATE/DELETE/TRUNCATE even for the most privileged role", async () => {
    // The trigger is the last line of defense: even a role with every privilege cannot
    // rewrite history. UPDATE/DELETE run as the cluster superuser (where one exists) to
    // make the strongest possible claim.
    await expect(
      root`update audit_log set action = ${"tampered"} where org_id = ${orgA.orgId} and seq = ${1}`,
    ).rejects.toThrow(/append-only/i);
    await expect(
      root`delete from audit_log where org_id = ${orgA.orgId} and seq = ${1}`,
    ).rejects.toThrow(/append-only/i);
    // TRUNCATE is gated by the TRUNCATE privilege *before* the BEFORE-TRUNCATE trigger
    // can fire. A true superuser bypasses that check, but managed Postgres (e.g. the Neon
    // branch the nightly runs against) exposes no cluster superuser — there, the would-be
    // superuser role lacks TRUNCATE and is denied one layer too early ("permission denied"),
    // never reaching the trigger. The table owner holds TRUNCATE on every engine and is the
    // highest-privilege role that actually exists in production, so assert the trigger via
    // the owner: it reaches and is blocked by the trigger both locally and on Neon.
    await expect(owner`truncate audit_log`).rejects.toThrow(/append-only/i);
  });
});

describe("auth_audit_event append-only hash chain (control-plane)", () => {
  it("enforces contiguous per-org seq starting at 1", async () => {
    await withTenant(app, orgA.orgId, async (tx) => {
      // org A already has seq 1 (seeded, row_hash = deterministicBuffer(32)); seq 2 linking to it is accepted.
      await tx`insert into auth_audit_event (org_id, seq, actor, event_type, prev_hash, row_hash)
               values (${orgA.orgId}, ${2}, ${orgA.userId}, ${"key_minted"}, ${deterministicBuffer(32)}, ${deterministicBuffer(33)})`;
    });
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`insert into auth_audit_event (org_id, seq, actor, event_type, prev_hash, row_hash)
                 values (${orgA.orgId}, ${5}, ${orgA.userId}, ${"key_minted"}, ${deterministicBuffer(33)}, ${deterministicBuffer(34)})`;
      }),
    ).rejects.toThrow(/contiguous/i);
  });

  it("rejects a contiguous row whose prev_hash does not match the prior row_hash", async () => {
    const chainOrg = randomUUID();
    await withTenant(app, chainOrg, async (tx) => {
      await tx`insert into orgs (id, slug, name) values (${chainOrg}, ${"aae-chainx"}, ${"AAE Chain"})`;
      // Genesis row: prev_hash omitted (defaults to NULL).
      await tx`insert into auth_audit_event (org_id, seq, event_type, row_hash)
               values (${chainOrg}, ${1}, ${"login"}, ${deterministicBuffer(40)})`;
    });
    await expect(
      withTenant(app, chainOrg, async (tx) => {
        await tx`insert into auth_audit_event (org_id, seq, event_type, prev_hash, row_hash)
                 values (${chainOrg}, ${2}, ${"key_minted"}, ${deterministicBuffer(41)}, ${deterministicBuffer(42)})`;
      }),
    ).rejects.toThrow(/prev_hash must equal/i);
  });

  it("rejects a genesis row with a non-null prev_hash", async () => {
    const freshOrg = randomUUID();
    await expect(
      withTenant(app, freshOrg, async (tx) => {
        await tx`insert into orgs (id, slug, name) values (${freshOrg}, ${"aae-genx"}, ${"AAE Gen"})`;
        await tx`insert into auth_audit_event (org_id, seq, event_type, prev_hash, row_hash)
                 values (${freshOrg}, ${1}, ${"login"}, ${deterministicBuffer(32)}, ${deterministicBuffer(33)})`;
      }),
    ).rejects.toThrow(/genesis/i);
  });

  it("rejects an unknown event_type (the check constraint)", async () => {
    const o = randomUUID();
    await expect(
      withTenant(app, o, async (tx) => {
        await tx`insert into orgs (id, slug, name) values (${o}, ${"aae-evt"}, ${"AAE Evt"})`;
        await tx`insert into auth_audit_event (org_id, seq, event_type, row_hash)
                 values (${o}, ${1}, ${"not_a_real_event"}, ${deterministicBuffer(32)})`;
      }),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("withholds UPDATE/DELETE privilege from the app role (privilege layer)", async () => {
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`update auth_audit_event set actor = ${"tampered"} where org_id = ${orgA.orgId} and seq = ${1}`;
      }),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`delete from auth_audit_event where org_id = ${orgA.orgId} and seq = ${1}`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("the immutability trigger blocks UPDATE/DELETE/TRUNCATE even for the most privileged role", async () => {
    await expect(
      root`update auth_audit_event set actor = ${"tampered"} where org_id = ${orgA.orgId} and seq = ${1}`,
    ).rejects.toThrow(/append-only/i);
    await expect(
      root`delete from auth_audit_event where org_id = ${orgA.orgId} and seq = ${1}`,
    ).rejects.toThrow(/append-only/i);
    await expect(owner`truncate auth_audit_event`).rejects.toThrow(/append-only/i);
  });
});

describe("api_keys credential extension (0014)", () => {
  it("owner_type defaults to 'user' and grant_id/audience default null for a directly-created key", async () => {
    const id = randomUUID();
    const [row] = await withTenant(app, orgA.orgId, async (tx) => {
      await tx`insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes)
               values (${id}, ${orgA.orgId}, ${randomBytes(32)}, ${"whk"}, ${"whk_d"}, ${"direct-key"}, ${tx.json([])})`;
      return tx<{ owner_type: string; grant_id: string | null; audience: string | null }[]>`
        select owner_type, grant_id, audience from api_keys where id = ${id}`;
    });
    expect(row.owner_type).toBe("user");
    expect(row.grant_id).toBeNull();
    expect(row.audience).toBeNull();
  });

  it("a key can be minted under an existing grant (grant_id FK + per-key audience)", async () => {
    const n = await withTenant(app, orgA.orgId, async (tx) => {
      const [grant] = await tx<{ id: string }[]>`
        select id from auth_grant where org_id = ${orgA.orgId} limit 1`;
      await tx`insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes, grant_id, audience)
               values (${randomUUID()}, ${orgA.orgId}, ${randomBytes(32)}, ${"whk"}, ${"whk_g"}, ${"grant-key"}, ${tx.json(["events:read"])}, ${grant.id}, ${"https://api.webhook.co"})`;
      const [{ c }] = await tx<{ c: number }[]>`
        select count(*)::int as c from api_keys where grant_id = ${grant.id}`;
      return c;
    });
    expect(n).toBe(1);
  });

  it("rejects a key whose grant_id references a non-existent grant (FK)", async () => {
    await expect(
      withTenant(app, orgA.orgId, async (tx) => {
        await tx`insert into api_keys (id, org_id, key_hash, prefix, start, name, scopes, grant_id)
                 values (${randomUUID()}, ${orgA.orgId}, ${randomBytes(32)}, ${"whk"}, ${"whk_x"}, ${"bad-grant"}, ${tx.json([])}, ${randomUUID()})`;
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("the authn cold-path column grant adds `audience` (0014) + `grant_id` (0018), not owner_type/sso_authorized", async () => {
    const [g] = await owner<
      {
        key_hash: boolean;
        audience: boolean;
        grant_id: boolean;
        owner_type: boolean;
        sso_authorized: boolean;
      }[]
    >`
      select has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'key_hash', 'SELECT') as key_hash,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'audience', 'SELECT') as audience,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'grant_id', 'SELECT') as grant_id,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'owner_type', 'SELECT') as owner_type,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'sso_authorized', 'SELECT') as sso_authorized`;
    expect(g.key_hash).toBe(true); // from 0009
    expect(g.audience).toBe(true); // added by 0014
    expect(g.grant_id).toBe(true); // added by 0018 (the /revoke whk_→grant cross-org lookup)
    expect(g.owner_type).toBe(false);
    expect(g.sso_authorized).toBe(false);
  });
});

describe("catalog-driven RLS coverage", () => {
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
      // audit_log + auth_audit_event are deliberately INSERT+SELECT only (no UPDATE/DELETE policy).
      const expected =
        table === "audit_log" || table === "auth_audit_event"
          ? ["INSERT", "SELECT"]
          : ["DELETE", "INSERT", "SELECT", "UPDATE"];
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

  it("the authn role is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    // webhook_authn is the bearer-verify role: it reads only the granted api_keys
    // columns (a separate FOR SELECT policy) and must be RLS-enforced like every other
    // request-path role — never a superuser, never BYPASSRLS, never a table owner.
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.authn}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const ownedByAuthn = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.authn}`;
    expect(ownedByAuthn[0]?.n).toBe(0);
  });

  it("the anchor role is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    // webhook_anchor is the WORM head-anchor cron role: it reads per-org chain heads across
    // tenants via a role-targeted SELECT policy + a column grant, and like every other
    // request/job-path role must never be a superuser, never BYPASSRLS, never a table owner.
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.anchor}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const ownedByAnchor = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.anchor}`;
    expect(ownedByAnchor[0]?.n).toBe(0);
  });

  it("the auth role is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    // webhook_auth is the Better Auth runtime role: it manages the global identity tables and,
    // like every other request-path role, must never be a superuser, never BYPASSRLS, never a
    // table owner (the identity tables are owned by webhook_owner, created in 0001).
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.auth}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const ownedByAuth = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.auth}`;
    expect(ownedByAuth[0]?.n).toBe(0);
  });

  it("the sweeper role is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    // webhook_sweeper is the cross-org expiry cron-sweep role (migration 0020): it deletes expired rows
    // from the two token tables across all orgs via a role-targeted DELETE policy, and like every other
    // job-path role must never be a superuser, never BYPASSRLS, never a table owner.
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.sweeper}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const ownedBySweeper = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.sweeper}`;
    expect(ownedBySweeper[0]?.n).toBe(0);
  });

  it("the sweeper role holds DELETE — and ONLY delete — on the two token tables, nothing elsewhere", async () => {
    // DELETE-only least privilege: the cron can't read any handle row (no SELECT), can't mint or rotate
    // (no INSERT/UPDATE), and the role-targeted USING (expires_at < now()) policy bounds its bare DELETE to
    // already-expired rows. It holds no privilege on any other tenant table.
    const tokenTables = ["auth_refresh_token", "auth_session_exchange"] as const;
    for (const t of tokenTables) {
      const [p] = await owner<{ s: boolean; i: boolean; u: boolean; d: boolean }[]>`
        select has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'SELECT') as s,
               has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'INSERT') as i,
               has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'UPDATE') as u,
               has_table_privilege(${DB_ROLES.sweeper}, ${t}, 'DELETE') as d`;
      expect([p.s, p.i, p.u, p.d]).toEqual([false, false, false, true]);
    }
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

  it("the auth role holds DML on the identity tables and nothing on tenant or plugin-apikey tables", async () => {
    // Better Auth (as webhook_auth) does full CRUD on the four global identity tables. It holds
    // NO privilege on the org-scoped tenant tables (webhook_app's, RLS-enforced) nor on the
    // plugin `apikey` table (generator-config-only, ADR-0019 — runtime keys are first-party api_keys).
    const identity = ["user", "session", "account", "verification"] as const;
    for (const t of identity) {
      const [p] = await owner<{ s: boolean; i: boolean; u: boolean; d: boolean }[]>`
        select has_table_privilege(${DB_ROLES.auth}, ${t}, 'SELECT') as s,
               has_table_privilege(${DB_ROLES.auth}, ${t}, 'INSERT') as i,
               has_table_privilege(${DB_ROLES.auth}, ${t}, 'UPDATE') as u,
               has_table_privilege(${DB_ROLES.auth}, ${t}, 'DELETE') as d`;
      expect([p.s, p.i, p.u, p.d]).toEqual([true, true, true, true]);
    }
    const forbidden = ["orgs", "api_keys", "events", "apikey"] as const;
    for (const t of forbidden) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.auth}, ${t}, 'SELECT')
             or has_table_privilege(${DB_ROLES.auth}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.auth}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.auth}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
  });
});

describe("webhook_anchor cross-org chain-head read", () => {
  it("reads every org's head with NO tenant context (role-targeted policy, not BYPASSRLS)", async () => {
    // The anchor cron sets no app.current_org. The role-targeted FOR SELECT TO webhook_anchor
    // USING(true) policy is what lets it see all orgs, while FORCE RLS still denies webhook_app
    // the same (proven by the deny-by-default test above). This is the cross-org read WITHOUT a
    // BYPASSRLS/SECURITY-DEFINER bypass — both of which FORCE RLS would defeat anyway.
    const heads = await anchor<{ org_id: string; seq: string; row_hash: Uint8Array }[]>`
      select distinct on (org_id) org_id, seq, row_hash
      from audit_log order by org_id, seq desc`;
    const orgIds = heads.map((h) => h.org_id);
    // Both seeded orgs are visible from a context-less anchor connection — i.e. it crosses
    // tenants (other tests may add more orgs, so assert membership, not an exact set).
    expect(orgIds).toContain(orgA.orgId);
    expect(orgIds).toContain(orgB.orgId);
  });

  it("cannot read the audit content columns (column grant is org_id, seq, row_hash only)", async () => {
    await expect(anchor`select actor from audit_log`).rejects.toThrow(/permission denied/i);
    await expect(anchor`select action from audit_log`).rejects.toThrow(/permission denied/i);
    await expect(anchor`select target from audit_log`).rejects.toThrow(/permission denied/i);
  });

  it("cannot write to audit_log (no INSERT/UPDATE/DELETE grant)", async () => {
    await expect(
      anchor`insert into audit_log (org_id, seq, action, row_hash)
             values (${orgA.orgId}, ${999}, ${"x"}, ${deterministicBuffer(32)})`,
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("no unexpected SECURITY DEFINER functions", () => {
  it("has zero SECURITY DEFINER functions in the public schema", async () => {
    // The schema intentionally ships no SECURITY DEFINER routine (all helpers are
    // INVOKER, so RLS is never silently bypassed). If a future migration adds one, it
    // must be reviewed and allowlisted here with a documented reason.
    const definers = await owner<{ proname: string }[]>`
      select proname from pg_proc
      where pronamespace = 'public'::regnamespace and prosecdef`;
    expect(definers.map((d) => d.proname)).toEqual([]);
  });
});
