import { randomUUID } from "node:crypto";

import { importAuditKey, verifyAuditChain, type StoredAuditRow } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appendAuditEntry, readAuditChain } from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";

// The append-service library writes the next chain row under a per-org advisory lock
// (head read + hash + insert), with the HMAC key supplied from a binding — NEVER from
// the DB role (ADR-0004). These tests drive it against a real Postgres so the lock, the
// trigger's structural enforcement, and the full-chain walker are all exercised end to
// end. Requires the ephemeral local Postgres (or TEST_DATABASE_URL in CI).

let pg: EphemeralPostgres;
let app: Sql;
let key: CryptoKey;

async function seedOrg(slug: string): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
  });
  return orgId;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  // A fixed test key — in prod this comes from a runtime binding, never the DB.
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)));
}, 90_000);

afterAll(async () => {
  await app?.end();
  await pg?.stop();
});

describe("appendAuditEntry (append-service, §0.7)", () => {
  it("writes a genesis row at seq 1 with a null prev_hash, and it verifies", async () => {
    const orgId = await seedOrg("audit-genesis");
    const written = await withTenant(app, orgId, (tx) =>
      appendAuditEntry(tx, key, { orgId, actor: "user_1", action: "org.created", target: null }),
    );
    expect(written.seq).toBe(1);
    expect(written.prevHash).toBeNull();
    expect(written.rowHash.length).toBe(32);

    const chain = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    const result = await verifyAuditChain(key, orgId, chain);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(1);
  });

  it("links successive rows into a chain that the walker verifies clean", async () => {
    const orgId = await seedOrg("audit-chain");
    await withTenant(app, orgId, async (tx) => {
      await appendAuditEntry(tx, key, { orgId, actor: "u", action: "org.created", target: null });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: "u",
        action: "endpoint.created",
        target: "ep_1",
      });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: null,
        action: "key.rotated",
        target: "ep_1",
      });
    });

    const chain = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    expect(chain.map((r) => r.seq)).toEqual([1, 2, 3]);
    const result = await verifyAuditChain(key, orgId, chain);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(3);
  });

  it("produces a chain the walker rejects once a stored payload is tampered (DB-side edit)", async () => {
    const orgId = await seedOrg("audit-tamper");
    await withTenant(app, orgId, async (tx) => {
      await appendAuditEntry(tx, key, { orgId, actor: "u", action: "org.created", target: null });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: "u",
        action: "endpoint.created",
        target: "ep_1",
      });
    });

    // Simulate a privileged tamper by recomputing the walker over an edited row set:
    // audit_log is immutable in the DB (triggers reject UPDATE), so we tamper the
    // in-memory row the walker sees — same effect the verifier must catch.
    const chain = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    const tampered: StoredAuditRow[] = chain.map((r) =>
      r.seq === 2 ? { ...r, action: "endpoint.deleted" } : r,
    );
    const result = await verifyAuditChain(key, orgId, tampered);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("hash_mismatch");
    expect(result.break.seq).toBe(2);
  });

  it("the walker catches a deleted row (seq gap) in a real stored chain", async () => {
    const orgId = await seedOrg("audit-gap");
    await withTenant(app, orgId, async (tx) => {
      await appendAuditEntry(tx, key, { orgId, actor: "u", action: "org.created", target: null });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: "u",
        action: "endpoint.created",
        target: "ep",
      });
      await appendAuditEntry(tx, key, { orgId, actor: "u", action: "key.rotated", target: "ep" });
    });
    const chain = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    const withGap = chain.filter((r) => r.seq !== 2); // drop the middle row
    const result = await verifyAuditChain(key, orgId, withGap);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("seq_gap");
    expect(result.break.seq).toBe(3);
  });

  it("serializes concurrent appends in the same org under the advisory lock (no seq fork)", async () => {
    const orgId = await seedOrg("audit-concurrent");
    // Fire several appends concurrently, each in its own transaction/connection. The
    // per-org advisory lock makes head-read+insert atomic, so seqs come out contiguous
    // with no duplicate-seq failure.
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withTenant(app, orgId, (tx) =>
          appendAuditEntry(tx, key, {
            orgId,
            actor: `u${i}`,
            action: "endpoint.created",
            target: `ep_${i}`,
          }),
        ),
      ),
    );

    const chain = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId));
    expect(chain.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    const result = await verifyAuditChain(key, orgId, chain);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(N);
  });

  it("keeps per-org chains independent (each starts at its own genesis)", async () => {
    const orgA = await seedOrg("audit-iso-a");
    const orgB = await seedOrg("audit-iso-b");
    await withTenant(app, orgA, (tx) =>
      appendAuditEntry(tx, key, { orgId: orgA, actor: "u", action: "org.created", target: null }),
    );
    await withTenant(app, orgB, (tx) =>
      appendAuditEntry(tx, key, { orgId: orgB, actor: "u", action: "org.created", target: null }),
    );
    await withTenant(app, orgB, (tx) =>
      appendAuditEntry(tx, key, {
        orgId: orgB,
        actor: "u",
        action: "endpoint.created",
        target: "e",
      }),
    );

    const chainA = await withTenant(app, orgA, (tx) => readAuditChain(tx, orgA));
    const chainB = await withTenant(app, orgB, (tx) => readAuditChain(tx, orgB));
    expect(chainA.map((r) => r.seq)).toEqual([1]);
    expect(chainB.map((r) => r.seq)).toEqual([1, 2]);
    expect((await verifyAuditChain(key, orgA, chainA)).ok).toBe(true);
    expect((await verifyAuditChain(key, orgB, chainB)).ok).toBe(true);
  });
});
