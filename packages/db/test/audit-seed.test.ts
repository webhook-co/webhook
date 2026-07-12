import { randomUUID } from "node:crypto";

import { importAuditKey, userActor, verifyAuditChain } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendAuditEntry, readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { buildAuditChainRows, seedAuditChain } from "./audit-seed";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The batched audit-window seeder. It exists because the OBVIOUS way to seed a rate-limit window —
// loop appendAuditEntry cap-many times — is a false-pass generator on a remote DB: each append is 3
// round-trips, audit_log.created_at is stamped with the TRANSACTION's now(), and the limiters count
// rows inside a 60s WALL-CLOCK window. 300 appends × 3 round-trips outlasts the window on Neon, so
// every seeded row is born already expired, the limiter never trips, and the test resolves instead
// of rejecting (nightly-rls, issue #383; the same class as the reveal limiter in #413).
//
// The seeder writes the identical chain in ONE insert. These tests hold it to the two properties
// that make it a legitimate substitute for the real append path: the chain it writes is
// cryptographically valid, and the DB's own append-only trigger accepts it.

let pg: EphemeralPostgres;
let app: Sql;
let auditKey: CryptoKey;

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  auditKey = await importAuditKey(
    new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 5) % 256)),
  );
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

async function seedOrg(orgId: string): Promise<void> {
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name, created_at)
             values (${orgId}, ${orgId.slice(0, 8)}, ${"o"}, ${"2026-01-01T00:00:00Z"})`;
  });
}

describe("buildAuditChainRows — the chain is built client-side, so seeding costs no round-trips", () => {
  it("builds a chain that verifyAuditChain accepts", async () => {
    const orgId = randomUUID();
    const rows = await buildAuditChainRows(
      auditKey,
      { orgId, actor: userActor("u_1"), action: "event.deleted", target: null },
      5,
      null,
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]!.seq).toBe(1);
    expect(rows[0]!.prevHash).toBeNull();
    await expect(verifyAuditChain(auditKey, orgId, rows)).resolves.toMatchObject({ ok: true });
  });

  it("continues an existing chain from its head (seq and prev_hash both pick up where it left off)", async () => {
    const orgId = randomUUID();
    const first = await buildAuditChainRows(
      auditKey,
      { orgId, actor: userActor("u_1"), action: "event.deleted", target: null },
      2,
      null,
    );
    const head = first.at(-1)!;
    const next = await buildAuditChainRows(
      auditKey,
      { orgId, actor: userActor("u_1"), action: "event.deleted", target: null },
      2,
      { seq: head.seq, rowHash: head.rowHash },
    );
    expect(next[0]!.seq).toBe(3);
    expect(next[0]!.prevHash).toEqual(head.rowHash);
    await expect(verifyAuditChain(auditKey, orgId, [...first, ...next])).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe("seedAuditChain — the DB accepts the batch, and the chain it stores verifies", () => {
  it("writes a valid chain the audit_log trigger accepts (it validates seq contiguity + prev_hash per row)", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await withTenant(app, orgId, (tx) =>
      seedAuditChain(
        tx,
        auditKey,
        { orgId, actor: userActor("u_1"), action: "event.deleted", target: null },
        25,
      ),
    );
    const stored = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    expect(stored).toHaveLength(25);
    await expect(verifyAuditChain(auditKey, orgId, stored)).resolves.toMatchObject({
      ok: true,
      rowsVerified: 25,
    });
  });

  it("appends onto a chain the REAL append path started — the two are interchangeable", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await withTenant(app, orgId, (tx) =>
      appendAuditEntry(tx, auditKey, {
        orgId,
        actor: userActor("u_0"),
        action: "endpoint.created",
        target: null,
      }),
    );
    await withTenant(app, orgId, (tx) =>
      seedAuditChain(
        tx,
        auditKey,
        { orgId, actor: userActor("u_1"), action: "event.deleted", target: null },
        10,
      ),
    );
    // …and the real path still appends cleanly on top of the seeded rows.
    await withTenant(app, orgId, (tx) =>
      appendAuditEntry(tx, auditKey, {
        orgId,
        actor: userActor("u_2"),
        action: "endpoint.created",
        target: null,
      }),
    );

    const stored = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    expect(stored).toHaveLength(12);
    expect(stored.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await expect(verifyAuditChain(auditKey, orgId, stored)).resolves.toMatchObject({ ok: true });
  });

  it("stamps every seeded row INSIDE the limiter's window — the point of the whole exercise", async () => {
    const orgId = randomUUID();
    await seedOrg(orgId);
    await withTenant(app, orgId, (tx) =>
      seedAuditChain(
        tx,
        auditKey,
        { orgId, actor: userActor("u_1"), action: "event.deleted", target: null },
        50,
      ),
    );
    // The limiters count exactly this way: rows for the org + action inside a 60s wall clock.
    const [{ count }] = await withTenant(
      app,
      orgId,
      (tx) => tx<{ count: number }[]>`
        select count(*)::int as count from audit_log
        where org_id = ${orgId} and action = ${"event.deleted"}
          and created_at > now() - make_interval(secs => ${60})`,
    );
    expect(count).toBe(50);
  });

  it("is RLS-policed like any other app write — it cannot seed another org's chain", async () => {
    const orgId = randomUUID();
    const otherOrg = randomUUID();
    await seedOrg(orgId);
    await expect(
      withTenant(app, orgId, (tx) =>
        seedAuditChain(
          tx,
          auditKey,
          { orgId: otherOrg, actor: userActor("u_1"), action: "event.deleted", target: null },
          3,
        ),
      ),
    ).rejects.toThrow();
  });
});
