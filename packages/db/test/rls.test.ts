import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createClient, withTenant, withUser, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

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
  { table: "org_slug_history", col: "org_id" },
  { table: "memberships", col: "org_id" },
  { table: "endpoints", col: "org_id" },
  { table: "signing_keys", col: "org_id" },
  { table: "provider_secrets", col: "org_id" },
  { table: "replay_destinations", col: "org_id" },
  { table: "delivery_subscriptions", col: "org_id" },
  { table: "events", col: "org_id" },
  { table: "delivery_attempts", col: "org_id" },
  { table: "usage", col: "org_id" },
  // Daily delivery-outcome rollup for the dashboard overview (migration 0063). Full org-scoped CRUD
  // (the hourly rollup upserts under RLS; the page reads under RLS) — same shape as `usage`.
  { table: "delivery_stats", col: "org_id" },
  { table: "org_limits", col: "org_id" },
  { table: "ingest_paused", col: "org_id" },
  { table: "usage_alerts", col: "org_id" },
  { table: "billing_customers", col: "org_id" },
  { table: "billing_subscriptions", col: "org_id" },
  { table: "stripe_meter_reports", col: "org_id" },
  { table: "audit_log", col: "org_id" },
  { table: "api_keys", col: "org_id" },
  { table: "auth_grant", col: "org_id" },
  { table: "auth_refresh_token", col: "org_id" },
  { table: "auth_session_exchange", col: "org_id" },
  { table: "org_policy", col: "org_id" },
  { table: "auth_audit_event", col: "org_id" },
  { table: "notification_intents", col: "org_id" },
  { table: "agent_triggers", col: "org_id" },
  // Pending org invitations (migration 0064). Full org-scoped CRUD under RLS — create/accept/revoke/list.
  { table: "org_invites", col: "org_id" },
  // Durable R2-purge job written at org-delete time (migration 0051). webhook_app inserts +
  // reads only its own org's job (the insert `with check` blocks forging another org's purge);
  // it holds no UPDATE/DELETE (see NO_UPDATE below). The cross-org drain is webhook_purge's.
  { table: "org_deletions", col: "org_id" },
  // Per-event R2-purge job written at events.delete (tombstone) time (migration 0058). Same shape as
  // org_deletions: webhook_app inserts + reads only its own org's jobs (insert `with check`), no
  // UPDATE/DELETE (NO_UPDATE below); the cross-org drain is webhook_purge's.
  { table: "event_payload_purge", col: "org_id" },
  // Durable Stripe-cancellation job written at org-delete time (migration 0075). Same shape as
  // org_deletions: webhook_app inserts + reads only its own org's job (insert `with check`), no
  // UPDATE/DELETE (NO_UPDATE below); the cross-org drain is webhook_billing's.
  { table: "org_billing_cancellations", col: "org_id" },
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
  // Global (non-org) Stripe inbound dedup ledger (S4.5a): a Stripe event.id is globally unique and not
  // org-scoped until the handler resolves org from signed metadata, so there is no org_id to RLS on;
  // access is by GRANT to the single webhook_billing writer role only.
  "processed_stripe_events",
  // In-flight email-change step-up state (0081): user-scoped identity-realm table (no org_id), alongside
  // user/session/account/verification. Access is by GRANT to the auth runtime role (webhook_auth) ONLY — the
  // OTP hash it holds must never be readable from the tenant/app role.
  "pending_email_change",
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
let reconciler: Sql; // webhook_reconciler — cross-org delivery-reconciliation reader (re-wake cron)
let notifier: Sql; // webhook_notifier — cross-org notification-drain (read intents+owner email, mark sent)
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
    await tx`insert into provider_secrets (id, endpoint_id, org_id, provider, secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, envelope_version, status)
             values (${randomUUID()}, ${endpointId}, ${orgId}, ${"stripe"}, ${deterministicBuffer(16)}, ${deterministicBuffer(16)}, ${"kek/1"}, ${deterministicBuffer(12)}, ${1}, ${"active"})`;
    const destinationId = randomUUID();
    await tx`insert into replay_destinations (id, org_id, url)
             values (${destinationId}, ${orgId}, ${`https://hooks-${slug}.example.com/in`})`;
    // signing_keys hangs off the receiving destination (migration 0026), not the source endpoint.
    await tx`insert into signing_keys (id, destination_id, org_id, secret_ciphertext, wrapped_dek, kek_ref, enc_nonce, envelope_version, status)
             values (${randomUUID()}, ${destinationId}, ${orgId}, ${deterministicBuffer(16)}, ${deterministicBuffer(16)}, ${"kek/1"}, ${deterministicBuffer(12)}, ${1}, ${"active"})`;
    await tx`insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, dedup_key, dedup_strategy)
             values (${eventId}, ${orgId}, ${endpointId}, ${`org/${orgId}/ep/${endpointId}/${eventId}`}, ${128}, ${"seed-dedup"}, ${"content_hash"})`;
    await tx`insert into delivery_attempts (id, org_id, event_id, target, status)
             values (${randomUUID()}, ${orgId}, ${eventId}, ${"localhost-tunnel"}, ${"delivered"})`;
    await tx`insert into delivery_subscriptions (id, org_id, source_endpoint_id, destination_id)
             values (${randomUUID()}, ${orgId}, ${endpointId}, ${destinationId})`;
    await tx`insert into notification_intents (id, org_id, kind, destination_id)
             values (${randomUUID()}, ${orgId}, ${"destination_disabled"}, ${destinationId})`;
    await tx`insert into usage (org_id, window_start, event_count) values (${orgId}, date_trunc('day', now()), ${1})`;
    await tx`insert into org_limits (org_id, event_cap, pause_policy) values (${orgId}, ${1000}, ${"pause"})`;
    await tx`insert into ingest_paused (org_id, paused) values (${orgId}, ${false})`;
    // stripe_meter_reports (S4.4a outbox) is INSERT-able by webhook_app; seed it here so the cross-org
    // isolation check on it is NON-vacuous. identifier is CHECK-bound to (org_id, day).
    await tx`insert into stripe_meter_reports (org_id, day, event_count, identifier)
             values (${orgId}, current_date, ${1}, ${orgId} || ':' || current_date::text)`;
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

  // billing_customers + billing_subscriptions are SELECT-only for webhook_app (S4.4a — writes are
  // verified-Stripe-only, added in S4.4b), so seed them as the SUPERUSER (bypasses RLS) — enough for the
  // cross-org READ isolation checks to bite (org B has rows; org A must still see 0). stripe_* ids org-unique.
  await root`insert into billing_customers (org_id, stripe_customer_id) values (${orgId}, ${"cus_" + slug})`;
  await root`insert into billing_subscriptions
             (org_id, stripe_subscription_id, plan, status, event_cap, current_period_start, current_period_end)
             values (${orgId}, ${"sub_" + slug}, ${"seed-plan"}, ${"active"}, ${1000},
                     date_trunc('month', now()), date_trunc('month', now()) + interval '1 month')`;

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
  reconciler = createClient(pg.urlFor({ role: DB_ROLES.reconciler }));
  notifier = createClient(pg.urlFor({ role: DB_ROLES.notifier }));
  root = createClient(pg.providerUrl);
  orgA = await seedOrg("aaa");
  orgB = await seedOrg("bbb");
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await ingest?.end();
  await owner?.end();
  await anchor?.end();
  await sweeper?.end();
  await reconciler?.end();
  await notifier?.end();
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

  // Some tables withhold UPDATE and/or DELETE from webhook_app (least privilege), so a mutate attempt throws
  // a PRIVILEGE error instead of returning 0-rows — the generic cross-org mutate check (which asserts
  // 0-rows-affected) can't run against those. Their write denial is asserted separately (the append-only
  // describes + the per-table privilege tests). audit_log + auth_audit_event are fully append-only (no
  // UPDATE/DELETE); usage_alerts is INSERT+SELECT only; stripe_meter_reports is INSERT+SELECT+UPDATE (an
  // outbox row is durable evidence — no DELETE), so it's excluded from the DELETE check but KEPT in UPDATE.
  // billing_customers/billing_subscriptions are SELECT-only for webhook_app (writes are verified-Stripe-only,
  // S4.4b) — so they too throw a privilege error on UPDATE/DELETE and are excluded from the generic checks.
  const NO_UPDATE = new Set([
    "audit_log",
    "auth_audit_event",
    "usage_alerts",
    "billing_customers",
    "billing_subscriptions",
    // org_deletions: webhook_app holds INSERT + SELECT only; the cursor/status updates are the
    // cross-org webhook_purge drain's, never a tenant's. No DELETE for anyone (jobs are durable
    // evidence a purge was requested), so NO_DELETE (below) inherits it too.
    "org_deletions",
    // event_payload_purge (0058): identical posture — INSERT+SELECT only for webhook_app, the
    // completion UPDATE is webhook_purge's, no DELETE for anyone.
    "event_payload_purge",
    // org_billing_cancellations (0075): INSERT+SELECT only for webhook_app; the status/attempts UPDATE
    // is the cross-org webhook_billing drain's, never a tenant's. No DELETE for anyone.
    "org_billing_cancellations",
    // org_slug_history (0069): append-only, and that is load-bearing rather than tidy. It is what the
    // never-recycle guard reads, so a tenant that could DELETE its own retired slug could then hand it to a
    // confederate — reopening the takeover the table exists to close. INSERT + SELECT, no UPDATE, no DELETE,
    // for anyone.
    "org_slug_history",
  ]);
  const NO_DELETE = new Set([...NO_UPDATE, "stripe_meter_reports"]);
  for (const { table, col } of TENANT_TABLES.filter((t) => !NO_UPDATE.has(t.table))) {
    it(`org A context cannot update org B rows in ${table}`, async () => {
      const affected = await withTenant(app, orgA.orgId, async (tx) => {
        const res =
          await tx`update ${tx(table)} set ${tx(col)} = ${tx(col)} where ${tx(col)} = ${orgB.orgId}`;
        return res.count;
      });
      expect(affected).toBe(0);
    });
  }

  for (const { table, col } of TENANT_TABLES.filter((t) => !NO_DELETE.has(t.table))) {
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

  it("usage_alerts is append-only for webhook_app (SELECT + INSERT only — no UPDATE/DELETE grant)", async () => {
    // The metering dedup ledger: the producer inserts (ON CONFLICT DO NOTHING) + selects, never mutates.
    // Least privilege = webhook_app holds no UPDATE/DELETE, so either attempt is a hard privilege error.
    for (const priv of ["UPDATE", "DELETE"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_table_privilege(${DB_ROLES.app}, 'usage_alerts', ${priv}) as ok`;
      expect(p.ok).toBe(false);
    }
    const [ins] = await owner<{ ok: boolean }[]>`
      select has_table_privilege(${DB_ROLES.app}, 'usage_alerts', 'INSERT') as ok`;
    expect(ins.ok).toBe(true);
  });

  it("stripe_meter_reports is an outbox for webhook_app (SELECT+INSERT+UPDATE, but NO DELETE)", async () => {
    // The Stripe meter-report outbox: rows transition pending→sending→sent (UPDATE), but a reported row is
    // durable evidence of what was metered — webhook_app holds no DELETE (least privilege), so a delete is a
    // hard privilege error, while insert/select/update are granted.
    for (const priv of ["SELECT", "INSERT", "UPDATE"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_table_privilege(${DB_ROLES.app}, 'stripe_meter_reports', ${priv}) as ok`;
      expect(p.ok).toBe(true);
    }
    const [del] = await owner<{ ok: boolean }[]>`
      select has_table_privilege(${DB_ROLES.app}, 'stripe_meter_reports', 'DELETE') as ok`;
    expect(del.ok).toBe(false);
  });

  it("billing_customers + billing_subscriptions are SELECT-ONLY for webhook_app (no tenant writes)", async () => {
    // Their stripe_customer_id / stripe_subscription_id are globally-unique EXTERNAL ids that can't be
    // CHECK-bound to org_id — so a tenant write could pre-claim another org's id. webhook_app therefore
    // holds SELECT only; the write path is verified-Stripe-only (S4.4b). Any INSERT/UPDATE/DELETE is denied.
    for (const table of ["billing_customers", "billing_subscriptions"] as const) {
      const [sel] = await owner<{ ok: boolean }[]>`
        select has_table_privilege(${DB_ROLES.app}, ${table}, 'SELECT') as ok`;
      expect(sel.ok).toBe(true);
      for (const priv of ["INSERT", "UPDATE", "DELETE"] as const) {
        const [p] = await owner<{ ok: boolean }[]>`
          select has_table_privilege(${DB_ROLES.app}, ${table}, ${priv}) as ok`;
        expect(p.ok).toBe(false);
      }
    }
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

  it("the authn last_used write grant (0072) is MINIMAL — update `last_used_at` ONLY, no other write", async () => {
    // webhook_authn's first-ever write privilege. This guard is what keeps it minimal: a future widening
    // (update on another column, or INSERT/DELETE) turns it red. Mirrors the reconciler-role least-privilege
    // assertions; there was NO write-privilege guard on api_keys before this grant existed.
    const [w] = await owner<
      {
        upd_last_used: boolean;
        sel_last_used: boolean;
        upd_scopes: boolean;
        upd_revoked: boolean;
        upd_org: boolean;
        upd_expires: boolean;
        tbl_insert: boolean;
        tbl_delete: boolean;
        tbl_update_all: boolean;
      }[]
    >`
      select has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'last_used_at', 'UPDATE') as upd_last_used,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'last_used_at', 'SELECT') as sel_last_used,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'scopes', 'UPDATE') as upd_scopes,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'revoked_at', 'UPDATE') as upd_revoked,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'org_id', 'UPDATE') as upd_org,
             has_column_privilege(${DB_ROLES.authn}, 'api_keys', 'expires_at', 'UPDATE') as upd_expires,
             has_table_privilege(${DB_ROLES.authn}, 'api_keys', 'INSERT') as tbl_insert,
             has_table_privilege(${DB_ROLES.authn}, 'api_keys', 'DELETE') as tbl_delete,
             has_table_privilege(${DB_ROLES.authn}, 'api_keys', 'UPDATE') as tbl_update_all`;
    expect(w.upd_last_used).toBe(true); // the one column it may write (0072)
    expect(w.sel_last_used).toBe(true); // + read, needed for the throttle condition's WHERE
    expect(w.upd_scopes).toBe(false); // and NOTHING else, in any direction:
    expect(w.upd_revoked).toBe(false); // a key can't be un/revoked from the authn pool
    expect(w.upd_org).toBe(false); // nor re-homed to another org
    expect(w.upd_expires).toBe(false);
    expect(w.tbl_insert).toBe(false); // can't forge a key
    expect(w.tbl_delete).toBe(false);
    expect(w.tbl_update_all).toBe(false); // NOT a table-wide UPDATE grant — column-scoped only

    // The enabling UPDATE policy is role-scoped to webhook_authn (not a global widening).
    const [p] = await owner<{ roles: string; cmd: string }[]>`
      select array_to_string(roles, ',') as roles, cmd from pg_policies
      where tablename = 'api_keys' and policyname = 'api_keys_authn_last_used'`;
    expect(p?.cmd).toBe("UPDATE");
    expect(p?.roles).toBe(DB_ROLES.authn);
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
      // Policy sets by table posture:
      //  - billing_customers/billing_subscriptions: SELECT (tenant) + INSERT/UPDATE (verified-Stripe-only
      //    writer, S4.5b), no DELETE — history lives in Stripe.
      //  - audit_log + auth_audit_event (append-only WORM) + usage_alerts (metering dedup): INSERT+SELECT.
      //  - stripe_meter_reports (outbox): INSERT+SELECT+UPDATE (pending→sending→sent), no DELETE.
      //  - org_deletions / event_payload_purge (purge jobs): INSERT+SELECT (tenant) + UPDATE
      //    (webhook_purge drains the cursor/status/completion), no DELETE — durable evidence a purge
      //    was requested.
      //  - org_billing_cancellations (0075): INSERT+SELECT (tenant) + UPDATE (webhook_billing drains
      //    the status/attempts), no DELETE — durable evidence a cancellation was requested.
      //  - everything else: full CRUD.
      const insertSelectUpdate =
        table === "billing_customers" ||
        table === "billing_subscriptions" ||
        table === "stripe_meter_reports" ||
        table === "org_deletions" ||
        table === "event_payload_purge" ||
        table === "org_billing_cancellations";
      const insertSelectOnly =
        table === "audit_log" || table === "auth_audit_event" || table === "usage_alerts";
      // org_slug_history (0069): webhook_app gets SELECT and NOTHING ELSE. The table is written exclusively by
      // SECURITY DEFINER triggers on `orgs` (rename + delete), because letting the app insert its own history
      // rows was a namespace-squatting hole: `with check (org_id = current_org_id())` constrains the column
      // you thought of, not the CLAIM being made — so an attacker could forge a row for any slug, paired with
      // their own org, and permanently deny it to everyone. History is DERIVED, never asserted.
      const selectOnly = table === "org_slug_history";
      const expected = selectOnly
        ? ["ALL", "SELECT"] // the tenant SELECT policy + the definer-only ALL policy
        : insertSelectUpdate
          ? ["INSERT", "SELECT", "UPDATE"]
          : insertSelectOnly
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

  it("the reconciler role is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    // webhook_reconciler is the cross-org delivery-reconciliation cron role (migration 0033): it reads which
    // destinations have due, unclaimed deliveries across all orgs via role-targeted SELECT policies + column
    // grants, and like every other job-path role must never be a superuser, never BYPASSRLS, never own a table.
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.reconciler}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const ownedByReconciler = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.reconciler}`;
    expect(ownedByReconciler[0]?.n).toBe(0);
  });

  it("the reconciler role holds SELECT on ONLY the reconciliation columns, and no write anywhere", async () => {
    // Column-level least privilege: it can read the keys it needs to decide which DO to wake, but NEVER the
    // payload pointer / captured headers / target URL / signing config, and holds no INSERT/UPDATE/DELETE.
    const daGranted = ["org_id", "destination_id", "status", "next_retry_at"] as const;
    for (const c of daGranted) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.reconciler}, 'delivery_attempts', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(true);
    }
    // These columns exist on delivery_attempts but are NOT granted — the reconciler never sees the delivery
    // target, the upstream response code/body, or the idempotency key.
    const daForbidden = ["target", "status_code", "error", "idempotency_key"] as const;
    for (const c of daForbidden) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.reconciler}, 'delivery_attempts', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    // The destination's URL + failure counter exist but are NOT granted (signing config lives in a separate
    // table the role has no privilege on at all).
    const rdForbidden = ["url", "consecutive_failures"] as const;
    for (const c of rdForbidden) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.reconciler}, 'replay_destinations', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    // No write on either table (INSERT/UPDATE/DELETE) — every mutation stays inside the DO under webhook_app.
    for (const t of ["delivery_attempts", "replay_destinations"] as const) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.reconciler}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.reconciler}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.reconciler}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
  });

  it("the cap-reconciler role is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    // webhook_capreconciler is the cross-user free-org-cap role (migration 0084): it reads the ownership graph
    // + entitlement + org service-state across all users via role-targeted SELECT policies + column grants,
    // and like every other job-path role must never be a superuser, never BYPASSRLS, never own a table.
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.capReconciler}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const ownedByCapReconciler = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.capReconciler}`;
    expect(ownedByCapReconciler[0]?.n).toBe(0);
  });

  it("the cap-reconciler holds SELECT on ONLY the detection columns, UPDATE on ONLY the suspend columns", async () => {
    // Column-level least privilege. Reads: the ownership graph, entitlement status, and org identity/state it
    // needs to find over-cap owners (0084) + the grace column (0085). Writes: ONLY the org suspend-lifecycle
    // columns + the ingest pause (0085). NEVER billing identifiers, plan, org display fields, and never the
    // ownership/entitlement tables it only reads.
    const grantedSelect = {
      memberships: ["org_id", "user_id", "role"],
      billing_subscriptions: ["org_id", "status"],
      orgs: ["id", "created_at", "status", "suspended_reason", "free_org_cap_grace_until"],
      ingest_paused: ["org_id", "paused", "reason"],
    } as const;
    for (const [table, cols] of Object.entries(grantedSelect)) {
      for (const c of cols) {
        const [p] = await owner<{ ok: boolean }[]>`
          select has_column_privilege(${DB_ROLES.capReconciler}, ${table}, ${c}, 'SELECT') as ok`;
        expect(p.ok).toBe(true);
      }
    }
    // Never granted SELECT — no Stripe identifiers, no plan, no org name/slug.
    const forbiddenSelect = {
      billing_subscriptions: ["stripe_subscription_id", "plan"],
      orgs: ["name", "slug"],
    } as const;
    for (const [table, cols] of Object.entries(forbiddenSelect)) {
      for (const c of cols) {
        const [p] = await owner<{ ok: boolean }[]>`
          select has_column_privilege(${DB_ROLES.capReconciler}, ${table}, ${c}, 'SELECT') as ok`;
        expect(p.ok).toBe(false);
      }
    }
    // UPDATE granted ONLY on the org suspend-lifecycle columns…
    const orgsUpdatable = [
      "status",
      "suspended_reason",
      "suspended_at",
      "free_org_cap_grace_until",
      "free_org_cap_reminded_at",
    ] as const;
    for (const c of orgsUpdatable) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.capReconciler}, 'orgs', ${c}, 'UPDATE') as ok`;
      expect(p.ok).toBe(true);
    }
    // …NEVER on the org's identity fields (it can suspend an org, never rename or re-slug it).
    for (const c of ["name", "slug", "region"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.capReconciler}, 'orgs', ${c}, 'UPDATE') as ok`;
      expect(p.ok).toBe(false);
    }
    // No INSERT/DELETE on orgs (suspend is an UPDATE only), and NO write at all on the read-only tables.
    for (const cmd of ["INSERT", "DELETE"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_table_privilege(${DB_ROLES.capReconciler}, 'orgs', ${cmd}) as ok`;
      expect(p.ok).toBe(false);
    }
    for (const t of ["memberships", "billing_subscriptions"] as const) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.capReconciler}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.capReconciler}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.capReconciler}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
    // ingest_paused: INSERT + UPDATE granted at the COLUMN level (upsert the pause) — asserted per-column
    // since a column grant doesn't confer table-level privilege — but NEVER DELETE (a resume flips the flag,
    // it doesn't remove the audit row).
    for (const cmd of ["INSERT", "UPDATE"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.capReconciler}, 'ingest_paused', 'paused', ${cmd}) as ok`;
      expect(p.ok).toBe(true);
    }
    const [del] = await owner<{ ok: boolean }[]>`
      select has_table_privilege(${DB_ROLES.capReconciler}, 'ingest_paused', 'DELETE') as ok`;
    expect(del.ok).toBe(false);
  });

  it("the cap reconciler can ENQUEUE a notification intent but never read, re-open, or delete one", async () => {
    // 0086: a suspension the user is never told about is the worst version of this feature, so the reconciler
    // enqueues its own warning/suspended intents IN THE SAME tx as the flag/suspend write. It gets INSERT and
    // nothing else — it must not be able to read other orgs' intents (the notifier's job), un-send one, or
    // clear the backlog.
    for (const c of ["id", "org_id", "kind", "destination_id", "context"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.capReconciler}, 'notification_intents', ${c}, 'INSERT') as ok`;
      expect(p.ok).toBe(true);
    }
    // Deliberately NOT granted `status` — the reconciler cannot mint an already-'sent' intent and thereby
    // suppress its own notification. The column default ('pending') is the only value it can produce.
    const [status] = await owner<{ ok: boolean }[]>`
      select has_column_privilege(${DB_ROLES.capReconciler}, 'notification_intents', 'status', 'INSERT') as ok`;
    expect(status.ok).toBe(false);
    for (const cmd of ["SELECT", "UPDATE", "DELETE"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_table_privilege(${DB_ROLES.capReconciler}, 'notification_intents', ${cmd}) as ok`;
      expect(p.ok).toBe(false);
    }
  });

  it("the notifier role is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    // webhook_notifier is the cross-org notification-drain role (migration 0034): it reads pending intents +
    // the org owner's email across all orgs and flips intents to sent, and like every other job-path role
    // must never be a superuser, never BYPASSRLS, never own a table.
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.notifier}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const ownedByNotifier = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.notifier}`;
    expect(ownedByNotifier[0]?.n).toBe(0);
  });

  it("the notifier role holds ONLY the intent/owner-email columns it needs, writes ONLY the sent-marking columns", async () => {
    // SELECT: the intent routing keys + status, the membership owner-lookup keys, and the owner's email only.
    const selects: Array<[string, string]> = [
      ["notification_intents", "kind"],
      ["notification_intents", "destination_id"],
      ["notification_intents", "context"],
      ["memberships", "role"],
      ["user", "email"],
    ];
    for (const [t, c] of selects) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.notifier}, ${t}, ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(true);
    }
    // It must NOT read the owner's name, nor any destination config (it links to the dashboard by id).
    for (const [t, c] of [
      ["user", "name"],
      ["replay_destinations", "url"],
    ] as Array<[string, string]>) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.notifier}, ${t}, ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    // UPDATE: only (status, sent_at) on notification_intents, and no write on memberships / user.
    const [upStatus] = await owner<{ ok: boolean }[]>`
      select has_column_privilege(${DB_ROLES.notifier}, 'notification_intents', 'status', 'UPDATE') as ok`;
    expect(upStatus.ok).toBe(true);
    const [upKind] = await owner<{ ok: boolean }[]>`
      select has_column_privilege(${DB_ROLES.notifier}, 'notification_intents', 'kind', 'UPDATE') as ok`;
    expect(upKind.ok).toBe(false);
    for (const t of ["memberships", "user"] as const) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.notifier}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.notifier}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.notifier}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
  });

  it("the notifier reads ONLY the org's display identity — never its state, billing, or lifecycle columns", async () => {
    // 0086 widened the notifier onto `orgs` so an email can NAME the org it is about. The producer of a
    // free-org-cap intent is webhook_capreconciler, whose own grant deliberately excludes orgs.name/slug —
    // so the name cannot be snapshotted into `context` the way the webhook_app-produced kinds do, and the
    // notifier must resolve it at render time. This grant is the narrowest thing that closes that gap:
    // display identity only, on a role that already reads every owner's email address.
    for (const c of ["id", "name", "slug"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.notifier}, 'orgs', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(true);
    }
    // Everything else on orgs stays fenced — the notifier renders emails, it does not observe org state.
    for (const c of [
      "status",
      "suspended_reason",
      "suspended_at",
      "free_org_cap_grace_until",
      "free_org_cap_reminded_at",
      "created_at",
      "image_key",
    ] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.notifier}, 'orgs', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    // And it can never write an org.
    const [w] = await owner<{ any: boolean }[]>`
      select (has_table_privilege(${DB_ROLES.notifier}, 'orgs', 'INSERT')
           or has_table_privilege(${DB_ROLES.notifier}, 'orgs', 'UPDATE')
           or has_table_privilege(${DB_ROLES.notifier}, 'orgs', 'DELETE')) as any`;
    expect(w.any).toBe(false);
  });

  it("the meter role is non-owner, non-superuser, no BYPASSRLS, and owns no tables", async () => {
    // webhook_meter is the cross-org metering-rollup enumeration role (migration 0040): it reads which
    // orgs have recent events / a stale-open usage day so the cron can roll each up per-org under
    // webhook_app RLS. Like every job-path role it must never be a superuser, never BYPASSRLS, never own a table.
    const [role] = await owner<{ rolname: string; super: boolean; bypass: boolean }[]>`
      select rolname, rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.meter}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);

    const ownedByMeter = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.meter}`;
    expect(ownedByMeter[0]?.n).toBe(0);
  });

  it("the meter role holds SELECT on ONLY the enumeration columns, and no write anywhere", async () => {
    // SELECT: only the enumeration columns — (org_id, received_at) on events, (org_id, window_start,
    // finalized_at) on usage (S4.1), and the soft-cap enumeration columns (org_id, event_cap,
    // pause_policy) on org_limits + (org_id, paused) on ingest_paused (S4.3 / migration 0042).
    const selects: Array<[string, string]> = [
      ["events", "org_id"],
      ["events", "received_at"],
      ["usage", "org_id"],
      ["usage", "window_start"],
      ["usage", "finalized_at"],
      ["org_limits", "org_id"],
      ["org_limits", "event_cap"],
      ["org_limits", "pause_policy"],
      ["ingest_paused", "org_id"],
      ["ingest_paused", "paused"],
      // billing_subscriptions enumeration keys for the S4.4c meter-reporter (migration 0045): which orgs
      // pay (org_id, status) + the period bounds + created_at (the meter floor). NOT the external id / plan.
      ["billing_subscriptions", "org_id"],
      ["billing_subscriptions", "status"],
      ["billing_subscriptions", "current_period_start"],
      ["billing_subscriptions", "current_period_end"],
      ["billing_subscriptions", "created_at"],
      // Definition B (migration 0049): a DISPATCH is a billed event, so the rollup's org enumeration must
      // find orgs whose only recent activity was an outbound delivery. Exactly the enumeration columns.
      ["delivery_attempts", "org_id"],
      ["delivery_attempts", "created_at"],
    ];
    for (const [t, c] of selects) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.meter}, ${t}, ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(true);
    }
    // It must NEVER read a payload / header / dedup column, nor the usage count itself, nor the
    // pause NARRATIVE columns (reason/since), nor the sensitive billing_subscriptions columns (the
    // external subscription id, plan, or event_cap) — enumeration needs the org + status + bounds only.
    for (const [t, c] of [
      ["events", "payload_r2_key"],
      ["events", "headers"],
      ["events", "dedup_key"],
      ["usage", "event_count"],
      ["ingest_paused", "reason"],
      ["ingest_paused", "since"],
      ["billing_subscriptions", "stripe_subscription_id"],
      ["billing_subscriptions", "plan"],
      ["billing_subscriptions", "event_cap"],
      // A dispatch row carries the customer's destination URL and delivery outcome. Enumeration counts
      // rows; it must never read WHERE an org delivers, nor whether it succeeded.
      ["delivery_attempts", "target"],
      ["delivery_attempts", "status"],
      ["delivery_attempts", "attempt"],
      ["delivery_attempts", "event_id"],
      ["delivery_attempts", "error"],
    ] as Array<[string, string]>) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.meter}, ${t}, ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    // No write anywhere: not on events/usage, not on the pause/limits tables. The producer READS the
    // cap + usage as webhook_meter and flips ingest_paused only as webhook_app under withTenant.
    for (const t of [
      "events",
      "usage",
      "org_limits",
      "ingest_paused",
      "billing_subscriptions",
      "delivery_attempts",
    ] as const) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.meter}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.meter}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.meter}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
    // The role-targeted policies must be FOR SELECT (not ALL) — a stray ALL policy would extend
    // the role's reach to writes the column grants happen not to cover.
    const policies = await owner<{ policyname: string; cmd: string }[]>`
      select policyname, cmd from pg_policies
      where schemaname = 'public' and policyname in
        ('events_meter_select', 'usage_meter_select', 'org_limits_meter_select',
         'ingest_paused_meter_select', 'billing_subscriptions_meter_select',
         'delivery_attempts_meter_select')`;
    expect(policies.map((p) => p.cmd).sort()).toEqual([
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
      "SELECT",
    ]);
  });

  it("the meter-AUDIT role is non-owner/no-BYPASSRLS, reads the frozen count (which webhook_meter can't), and can never write", async () => {
    // webhook_meter_audit (S4.4d / migration 0046, money guard F6) recounts raw events cross-org and
    // compares to the frozen usage.event_count. It must be a non-privileged reader like every job role.
    const [role] = await owner<{ super: boolean; bypass: boolean }[]>`
      select rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.meterAudit}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);
    const owned = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.meterAudit}`;
    expect(owned[0]?.n).toBe(0);

    // SELECT on exactly its columns: (org_id, received_at) on events + (org_id, window_start,
    // event_count, finalized_at) on usage. Crucially it reads usage.event_count — the frozen billing
    // count that webhook_meter is DELIBERATELY denied — because reconciliation must compare it.
    for (const [t, c] of [
      ["events", "org_id"],
      ["events", "received_at"],
      ["usage", "org_id"],
      ["usage", "window_start"],
      ["usage", "event_count"],
      ["usage", "finalized_at"],
      // Definition B (0049): the oracle recounts BOTH legs, and must know which basis produced each row
      // (`counts_deliveries`) so it never recounts frozen capture-only history under the new definition.
      ["usage", "counts_deliveries"],
      ["delivery_attempts", "org_id"],
      ["delivery_attempts", "created_at"],
    ] as Array<[string, string]>) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.meterAudit}, ${t}, ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(true);
    }
    // Never a payload / header / dedup column — it counts rows, it must not read content.
    for (const [t, c] of [
      ["events", "payload_r2_key"],
      ["events", "headers"],
      ["events", "dedup_key"],
      // It counts dispatches; it must never learn a destination URL or a delivery outcome.
      ["delivery_attempts", "target"],
      ["delivery_attempts", "status"],
      ["delivery_attempts", "attempt"],
      ["delivery_attempts", "error"],
    ] as Array<[string, string]>) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.meterAudit}, ${t}, ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    // No write anywhere on events/usage; the role-targeted policies are FOR SELECT only.
    for (const t of ["events", "usage", "delivery_attempts"] as const) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.meterAudit}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.meterAudit}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.meterAudit}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
    const auditPolicies = await owner<{ cmd: string }[]>`
      select cmd from pg_policies where schemaname = 'public'
      and policyname in ('events_meter_audit_select', 'usage_meter_audit_select',
                         'delivery_attempts_meter_audit_select')`;
    expect(auditPolicies.map((p) => p.cmd).sort()).toEqual(["SELECT", "SELECT", "SELECT"]);
  });

  it("the meter-TRANSPORT role is non-owner/no-BYPASSRLS, reads the outbox + customer map only, never writes", async () => {
    // webhook_meter_transport (WS1 / migration 0050) reconciles what we told Stripe (outbox `sent` rows)
    // against what Stripe aggregated. It reads billing_customers.stripe_customer_id — an EXTERNAL id — so it
    // is a distinct role from the recount oracle. Read-only, non-privileged, like every job role.
    const [role] = await owner<{ super: boolean; bypass: boolean }[]>`
      select rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.meterTransport}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);
    const owned = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.meterTransport}`;
    expect(owned[0]?.n).toBe(0);

    // SELECT on exactly its columns: the value we POSTed + send markers, and the org→Stripe-customer map.
    for (const [t, c] of [
      ["stripe_meter_reports", "org_id"],
      ["stripe_meter_reports", "day"],
      ["stripe_meter_reports", "event_count"],
      ["stripe_meter_reports", "status"],
      ["stripe_meter_reports", "sent_at"],
      ["billing_customers", "org_id"],
      ["billing_customers", "stripe_customer_id"],
    ] as Array<[string, string]>) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.meterTransport}, ${t}, ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(true);
    }
    // NEVER the internal identifier / echoed stripe id, and never billing_customers.created_at.
    for (const [t, c] of [
      ["stripe_meter_reports", "identifier"],
      ["stripe_meter_reports", "stripe_meter_event_id"],
      ["stripe_meter_reports", "attempts"],
      ["billing_customers", "created_at"],
    ] as Array<[string, string]>) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.meterTransport}, ${t}, ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    // No write anywhere; the role-targeted policies are FOR SELECT only.
    for (const t of ["stripe_meter_reports", "billing_customers"] as const) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.meterTransport}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.meterTransport}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.meterTransport}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
    const transportPolicies = await owner<{ cmd: string }[]>`
      select cmd from pg_policies where schemaname = 'public'
      and policyname in ('stripe_meter_reports_transport_select', 'billing_customers_transport_select')`;
    expect(transportPolicies.map((p) => p.cmd).sort()).toEqual(["SELECT", "SELECT"]);
  });

  it("the billing writer role is non-owner/no-BYPASSRLS and holds exactly the verified-Stripe-writer grants", async () => {
    // webhook_billing (S4.5, migrations 0047/0048) is the verified-Stripe-only writer: insert+select on the
    // dedup ledger, and (S4.5b) the billing-state writes — insert/update on billing_customers/subscriptions,
    // full mirror (incl. delete for the Free downgrade) on org_limits. It must never be privileged.
    const [role] = await owner<{ super: boolean; bypass: boolean }[]>`
      select rolsuper as super, rolbypassrls as bypass
      from pg_roles where rolname = ${DB_ROLES.billing}`;
    expect(role).toBeDefined();
    expect(role.super).toBe(false);
    expect(role.bypass).toBe(false);
    const owned = await owner<{ n: number }[]>`
      select count(*)::int as n from pg_class
      where relkind = 'r' and relnamespace = 'public'::regnamespace
        and pg_get_userbyid(relowner) = ${DB_ROLES.billing}`;
    expect(owned[0]?.n).toBe(0);

    // Assert the EXACT privilege set per table (has_table_privilege reads the ACL, remote-safe).
    const expected: Record<string, string[]> = {
      // dedup ledger: insert+select only (an event id, once recorded, is immutable evidence).
      processed_stripe_events: ["INSERT", "SELECT"],
      // billing state: insert/update/select, NO delete (history lives in Stripe).
      billing_customers: ["INSERT", "SELECT", "UPDATE"],
      billing_subscriptions: ["INSERT", "SELECT", "UPDATE"],
      // cap mirror: full CRUD (delete removes the paid cap on a downgrade → Free default).
      org_limits: ["DELETE", "INSERT", "SELECT", "UPDATE"],
    };
    for (const [t, want] of Object.entries(expected)) {
      const got: string[] = [];
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
        const [p] = await owner<{ ok: boolean }[]>`
          select has_table_privilege(${DB_ROLES.billing}, ${t}, ${priv}) as ok`;
        if (p.ok) got.push(priv);
      }
      expect(got.sort()).toEqual(want);
    }
    // It must NOT reach unrelated tenant tables (e.g. events / endpoints / usage).
    for (const t of ["events", "endpoints", "usage"] as const) {
      const [p] = await owner<{ any: boolean }[]>`
        select (has_table_privilege(${DB_ROLES.billing}, ${t}, 'INSERT')
             or has_table_privilege(${DB_ROLES.billing}, ${t}, 'UPDATE')
             or has_table_privilege(${DB_ROLES.billing}, ${t}, 'SELECT')
             or has_table_privilege(${DB_ROLES.billing}, ${t}, 'DELETE')) as any`;
      expect(p.any).toBe(false);
    }
  });

  it("the authn role reads ONLY (org_id, paused) on ingest_paused for the cold-lookup OR-in — never the reason note, never a write", async () => {
    // The ingest cold lookup (webhook_authn) LEFT JOINs ingest_paused to OR org-level pause into the
    // resolved endpoint's paused flag (S4.3, migration 0042). That grant must be the boolean flag only:
    // authn never needs the pause NARRATIVE (reason/since), and must not write pause state.
    for (const c of ["org_id", "paused"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.authn}, 'ingest_paused', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(true);
    }
    for (const c of ["reason", "since", "updated_at"] as const) {
      const [p] = await owner<{ ok: boolean }[]>`
        select has_column_privilege(${DB_ROLES.authn}, 'ingest_paused', ${c}, 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
    const [w] = await owner<{ any: boolean }[]>`
      select (has_table_privilege(${DB_ROLES.authn}, 'ingest_paused', 'INSERT')
           or has_table_privilege(${DB_ROLES.authn}, 'ingest_paused', 'UPDATE')
           or has_table_privilege(${DB_ROLES.authn}, 'ingest_paused', 'DELETE')) as any`;
    expect(w.any).toBe(false);
    const [pol] = await owner<{ cmd: string }[]>`
      select cmd from pg_policies
      where schemaname = 'public' and policyname = 'ingest_paused_authn_select'`;
    expect(pol.cmd).toBe("SELECT");
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

describe("webhook_reconciler cross-org delivery read", () => {
  it("reads delivery_attempts + replay_destinations with NO tenant context (role-targeted policy)", async () => {
    // The reconciler cron sets no app.current_org. The role-targeted FOR SELECT TO webhook_reconciler
    // USING(true) policies let it scan both tables across all orgs, while FORCE RLS still denies webhook_app
    // the same (the deny-by-default tests above). No BYPASSRLS/SECURITY-DEFINER bypass involved.
    await expect(
      reconciler`select org_id, destination_id, status, next_retry_at from delivery_attempts limit 1`,
    ).resolves.toBeDefined();
    await expect(
      reconciler`select id, org_id, deleted_at, disabled_at from replay_destinations limit 1`,
    ).resolves.toBeDefined();
  });

  it("cannot read the ungranted columns (column grants bound the read)", async () => {
    await expect(reconciler`select target from delivery_attempts`).rejects.toThrow(
      /permission denied/i,
    );
    await expect(reconciler`select url from replay_destinations`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("cannot write to either table (no INSERT/UPDATE/DELETE grant)", async () => {
    await expect(
      reconciler`update delivery_attempts set status = ${"delivered"} where org_id = ${orgA.orgId}`,
    ).rejects.toThrow(/permission denied/i);
    await expect(
      reconciler`update replay_destinations set disabled_at = now() where org_id = ${orgA.orgId}`,
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("the org-directory capability (0067) is CONFINED to the definer", () => {
  it("gives webhook_app NO user-scoped policy — an unqualified membership read stays org-bound", async () => {
    // THE invariant of migration 0067, and the whole reason it is shaped the way it is.
    //
    // The tempting design was a permissive `user_id = current_app_user()` policy ON webhook_app. Policies OR
    // together, so that would make every membership read WITHOUT an explicit org_id silently CROSS-ORG —
    // and `select role from memberships where user_id = $1 limit 1` (the exact shape Lane S.4 fixed, no
    // org_id, no ORDER BY) would then return an ARBITRARY row: a plain `member` of a team who OWNS their
    // personal org reads back `owner` and clears an owner/admin gate ON THE TEAM.
    //
    // So webhook_app has no such policy. Pin it: even with the user GUC set, an unqualified read as
    // webhook_app must see nothing outside the tenant context.
    const policies = await owner<{ polname: string }[]>`
      select pol.polname
      from pg_policy pol
      join pg_class c on c.oid = pol.polrelid
      where c.relname in ('memberships', 'orgs')
        and 'webhook_app'::regrole = any(pol.polroles)`;
    expect(policies).toEqual([]); // no webhook_app-scoped policy on either table

    // Behavioural proof, not just catalog shape: orgA's user is in orgA only. With the user GUC set and NO
    // tenant context, webhook_app sees NOTHING — the cross-org rows are reachable only via the definer.
    const leaked = await withUser(
      app,
      orgA.userId,
      (tx) => tx<{ org_id: string }[]>`select org_id from memberships`,
    );
    expect(leaked).toEqual([]);
  });

  it("…while user_org_directory() DOES resolve the caller's orgs (the capability still works)", async () => {
    const rows = await withUser(
      app,
      orgA.userId,
      (tx) => tx<{ org_id: string }[]>`select org_id from user_org_directory()`,
    );
    expect(rows.map((r) => r.org_id)).toContain(orgA.orgId);
    expect(rows.map((r) => r.org_id)).not.toContain(orgB.orgId);
  });
});

describe("no unexpected SECURITY DEFINER functions", () => {
  /**
   * The ALLOWLIST. The schema ships INVOKER helpers by default so RLS is never silently bypassed; each
   * SECURITY DEFINER routine must be reviewed and justified here.
   *
   * `org_member_directory` (0066) — reads member identity (name/email) for the members list. Those columns
   * live in `"user"`, Better Auth's GLOBAL table, which has no org column and is deliberately NOT RLS'd (it
   * is written by webhook_auth on the login path). The alternative was to grant webhook_app a plain
   * `select` on `"user"` — which would put tenant isolation in the hands of every future query author
   * remembering to join `memberships`, i.e. app-layer filtering as the sole isolation mechanism.
   *
   * Sealing the join inside this function is STRICTLY SAFER, and it bypasses no RLS:
   *   - `memberships` is FORCE RLS, so it is policed by current_org_id() even for the definer;
   *   - `"user"` has no RLS to bypass in the first place;
   *   - the body carries an explicit `org_id = current_org_id()` predicate;
   *   - current_org_id() is NULL when unset ⇒ zero rows (deny-by-default), not the whole table;
   *   - search_path is pinned, so the definer cannot be search-path-hijacked.
   * The properties that make it safe are asserted below — the allowlist entry is not taken on trust.
   */
  const ALLOWED_SECURITY_DEFINERS = [
    "current_user_profile",
    "org_member_directory",
    // The never-recycle guard on orgs.slug. SECURITY DEFINER because under webhook_app's own RLS the history
    // read would be tenant-scoped — so a squatter's transaction, scoped to the SQUATTER'S org, would see an
    // empty history and take the retired slug. That is the entire attack it exists to refuse.
    "orgs_slug_not_retired",
    // Records the retirement on rename/delete. SECURITY DEFINER because webhook_app has NO write grant on
    // org_slug_history — deliberately: letting the app assert its own history was a namespace-squatting hole.
    // History is DERIVED by the database, never claimed by the caller.
    "orgs_slug_record_history",
    "user_org_directory",
  ];

  it("has no SECURITY DEFINER functions beyond the reviewed allowlist", async () => {
    const definers = await owner<{ proname: string }[]>`
      select proname from pg_proc
      where pronamespace = 'public'::regnamespace and prosecdef
      order by proname`;
    expect(definers.map((d) => d.proname)).toEqual(ALLOWED_SECURITY_DEFINERS);
  });

  it("webhook_app cannot read the identity table directly — the function is the ONLY path", async () => {
    // If this ever passes, the isolation argument above has collapsed: the tenant role could enumerate
    // every user in the system, in any org.
    await expect(app`select id, email from "user" limit 1`).rejects.toThrow(/permission denied/i);
  });

  it("org_member_directory returns ONLY the current org's members, and nothing when unscoped", async () => {
    const inA = await withTenant(
      app,
      orgA.orgId,
      (tx) => tx<{ user_id: string }[]>`select user_id from org_member_directory()`,
    );
    const inB = await withTenant(
      app,
      orgB.orgId,
      (tx) => tx<{ user_id: string }[]>`select user_id from org_member_directory()`,
    );
    // Whatever each org has, neither can see the other's members.
    const idsA = inA.map((r) => r.user_id);
    const idsB = inB.map((r) => r.user_id);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);

    // No tenant GUC set ⇒ current_org_id() is NULL ⇒ deny-by-default, not a full-table read.
    const unscoped = await app<{ user_id: string }[]>`select user_id from org_member_directory()`;
    expect(unscoped).toEqual([]);
  });
});
