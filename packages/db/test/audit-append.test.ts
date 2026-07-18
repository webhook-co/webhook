import { randomUUID } from "node:crypto";

import {
  importAuditKey,
  SYSTEM_ACTOR,
  userActor,
  verifyAuditChain,
  type StoredAuditRow,
} from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendAuditEntry,
  listAuditEntries,
  readAuditChain,
  verifyAuditChainPaged,
} from "../src/audit-append";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The append-service library writes the next chain row under a per-org advisory lock
// (head read + hash + insert), with the HMAC key supplied from a binding — NEVER from
// the DB role (ADR-0004). These tests drive it against a real Postgres so the lock, the
// trigger's structural enforcement, and the full-chain walker are all exercised end to
// end. Requires the ephemeral local Postgres (or TEST_DATABASE_URL in CI).

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql; // superuser locally — used ONLY to forge tamper the append service can't (bypassed constraints)
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
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  // A fixed test key — in prod this comes from a runtime binding, never the DB.
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) % 256)));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await pg?.stop();
});

describe("appendAuditEntry (append-service)", () => {
  it("writes a genesis row at seq 1 with a null prev_hash, and it verifies", async () => {
    const orgId = await seedOrg("audit-genesis");
    const written = await withTenant(app, orgId, (tx) =>
      appendAuditEntry(tx, key, {
        orgId,
        actor: userActor("user_1"),
        action: "org.created",
        target: null,
      }),
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
      await appendAuditEntry(tx, key, {
        orgId,
        actor: userActor("u"),
        action: "org.created",
        target: null,
      });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: userActor("u"),
        action: "endpoint.created",
        target: "ep_1",
      });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: SYSTEM_ACTOR,
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
      await appendAuditEntry(tx, key, {
        orgId,
        actor: userActor("u"),
        action: "org.created",
        target: null,
      });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: userActor("u"),
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
      await appendAuditEntry(tx, key, {
        orgId,
        actor: userActor("u"),
        action: "org.created",
        target: null,
      });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: userActor("u"),
        action: "endpoint.created",
        target: "ep",
      });
      await appendAuditEntry(tx, key, {
        orgId,
        actor: userActor("u"),
        action: "key.rotated",
        target: "ep",
      });
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
            actor: userActor(`u${i}`),
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
      appendAuditEntry(tx, key, {
        orgId: orgA,
        actor: userActor("u"),
        action: "org.created",
        target: null,
      }),
    );
    await withTenant(app, orgB, (tx) =>
      appendAuditEntry(tx, key, {
        orgId: orgB,
        actor: userActor("u"),
        action: "org.created",
        target: null,
      }),
    );
    await withTenant(app, orgB, (tx) =>
      appendAuditEntry(tx, key, {
        orgId: orgB,
        actor: userActor("u"),
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

// The dashboard list read (Lane 2.8). Keyset on `seq` — a per-org monotonic bigint — rather than the shared
// ISO-µs Cursor (which needs a UUID id; audit_log's is a bigserial). For an audit list the property that
// matters is that paging can neither SKIP nor DUPLICATE a row, which a single monotonic integer guarantees.
describe("listAuditEntries", () => {
  it("returns newest-first and pages through the whole chain without skipping or repeating a row", async () => {
    const orgId = await seedOrg("audit-list");
    for (let i = 0; i < 5; i++) {
      await withTenant(app, orgId, (tx) =>
        appendAuditEntry(tx, key, {
          orgId,
          actor: { kind: "user", id: "u_1" },
          action: `endpoint.created`,
          target: `ep_${i}`,
        }),
      );
    }

    const first = await withTenant(app, orgId, (tx) => listAuditEntries(tx, { limit: 2 }));
    expect(first.items.map((i) => i.seq)).toEqual([5, 4]); // newest first
    expect(first.items[0]?.target).toBe("ep_4");
    expect(first.nextSeq).toBe(4);

    const second = await withTenant(app, orgId, (tx) =>
      listAuditEntries(tx, { limit: 2, afterSeq: first.nextSeq }),
    );
    expect(second.items.map((i) => i.seq)).toEqual([3, 2]);

    const third = await withTenant(app, orgId, (tx) =>
      listAuditEntries(tx, { limit: 2, afterSeq: second.nextSeq }),
    );
    expect(third.items.map((i) => i.seq)).toEqual([1]);
    expect(third.nextSeq).toBeNull(); // exhausted

    // Every row seen exactly once, in order.
    const all = [...first.items, ...second.items, ...third.items].map((i) => i.seq);
    expect(all).toEqual([5, 4, 3, 2, 1]);
  });

  it("carries the PREFIXED actor through, so the UI can say who did it", async () => {
    const orgId = await seedOrg("audit-list-actor");
    await withTenant(app, orgId, (tx) =>
      appendAuditEntry(tx, key, {
        orgId,
        actor: { kind: "key", id: "k_9" },
        action: "endpoint.deleted",
        target: "ep_x",
      }),
    );
    const page = await withTenant(app, orgId, (tx) => listAuditEntries(tx, { limit: 10 }));
    expect(page.items[0]?.actor).toBe("key:k_9");
  });

  it("is RLS-scoped — one org never sees another's entries", async () => {
    const a = await seedOrg("audit-list-a");
    const b = await seedOrg("audit-list-b");
    await withTenant(app, a, (tx) =>
      appendAuditEntry(tx, key, {
        orgId: a,
        actor: { kind: "system" },
        action: "org.deleted",
        target: null,
      }),
    );

    const inB = await withTenant(app, b, (tx) => listAuditEntries(tx, { limit: 50 }));
    expect(inB.items).toEqual([]);
  });
});

describe("verifyAuditChainPaged (streaming verification, #636)", () => {
  async function seedChain(orgId: string, n: number): Promise<void> {
    await withTenant(app, orgId, async (tx) => {
      for (let i = 0; i < n; i++) {
        await appendAuditEntry(tx, key, {
          orgId,
          actor: i % 2 === 0 ? userActor("u") : SYSTEM_ACTOR,
          action: `action.${i + 1}`,
          target: i === 0 ? null : `t_${i}`,
        });
      }
    });
  }

  it("verifies an intact chain across MANY pages (a tiny pageSize forces the boundaries)", async () => {
    const orgId = await seedOrg("audit-paged-ok");
    await seedChain(orgId, 5);
    // pageSize 2 → pages [1,2] [3,4] [5]: the prev_hash link at seq 3 and seq 5 is checked across a boundary.
    const result = await verifyAuditChainPaged(app, orgId, key, 2);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(5);
  });

  it("matches the whole-chain verifier exactly (same ok + rowsVerified) at any pageSize", async () => {
    const orgId = await seedOrg("audit-paged-match");
    await seedChain(orgId, 7);
    const whole = await withTenant(app, orgId, (tx) => readAuditChain(tx, orgId)).then((rows) =>
      verifyAuditChain(key, orgId, rows),
    );
    for (const pageSize of [1, 3, 7, 100]) {
      const paged = await verifyAuditChainPaged(app, orgId, key, pageSize);
      expect(paged).toEqual(whole);
    }
  });

  it("still catches tampering (a wrong key) through the paged reader", async () => {
    const orgId = await seedOrg("audit-paged-key");
    await seedChain(orgId, 4);
    const wrongKey = await importAuditKey(new Uint8Array(32).fill(9));
    const result = await verifyAuditChainPaged(app, orgId, wrongKey, 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("hash_mismatch");
    expect(result.break.seq).toBe(1); // the genesis row already fails to recompute
  });

  it("an empty chain is vacuously valid (no page read past the first)", async () => {
    const orgId = await seedOrg("audit-paged-empty");
    const result = await verifyAuditChainPaged(app, orgId, key, 10);
    expect(result).toEqual({ ok: true, rowsVerified: 0 });
  });

  it("rejects a non-positive pageSize rather than silently certifying an unread chain (#636 review)", async () => {
    const orgId = await seedOrg("audit-paged-badsize");
    await seedChain(orgId, 2);
    // A pageSize <= 0 would read `limit 0`, get an empty first page, and FALSELY report ok — refuse it.
    await expect(verifyAuditChainPaged(app, orgId, key, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(verifyAuditChainPaged(app, orgId, key, -5)).rejects.toBeInstanceOf(RangeError);
  });

  // #636 review: the first version paged with a seq-only keyset seeded at `seq > 0`. A forged pre-genesis row
  // at seq <= 0 is a valid unique (seq 0 is otherwise unused) but an ILLEGAL genesis — the whole-chain
  // verifier flags bad_genesis_seq, but a `seq > 0` first page skipped it and reported the chain intact.
  it("catches a forged pre-genesis row (seq 0) a seq>0 first page would skip (#636 review)", async () => {
    const orgId = await seedOrg("audit-paged-genesis");
    await seedChain(orgId, 3); // real rows at seq 1,2,3
    // Forge the row past the append-validation trigger — the DB-side tamper the verifier exists to detect.
    // owner does the DDL (disable trigger); the insert itself runs under the org's RLS context via app.
    await owner`alter table audit_log disable trigger audit_log_chain_biu`;
    try {
      await withTenant(
        app,
        orgId,
        (tx) => tx`
        insert into audit_log (org_id, seq, action, prev_hash, row_hash)
        values (${orgId}, ${0}, ${"forged.genesis"}, ${null}, ${Buffer.from(new Uint8Array(32))})`,
      );
    } finally {
      await owner`alter table audit_log enable trigger audit_log_chain_biu`;
    }
    // pageSize 2 → first page (no lower bound) is [seq0, seq1]; the true minimum is seen.
    const result = await verifyAuditChainPaged(app, orgId, key, 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("bad_genesis_seq");
    expect(result.break.seq).toBe(0);
  });

  // #636 review: the seq-only keyset skipped a FORKED duplicate seq whenever the page boundary fell between
  // the two rows sharing that seq — losing the whole-chain verifier's duplicate_seq detection. The compound
  // (seq, id) keyset never skips a boundary row. This forces exactly that boundary. Runs LAST: it drops the
  // unique(org_id, seq) constraint (a superuser tamper the verifier exists to catch) and does not restore it.
  it("catches a forked duplicate seq split across a page boundary (#636 review)", async () => {
    const orgId = await seedOrg("audit-paged-fork");
    await seedChain(orgId, 4); // real rows at seq 1,2,3,4
    const [uniq] = await owner<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid = 'audit_log'::regclass and contype = 'u'`;
    // Bypass BOTH DB guards the way a superuser tamper would: the unique(org_id, seq) constraint and the
    // append-validation trigger. This is precisely the compromised-DB state the app-side verifier defends
    // against (the HMAC key lives outside the DB). Left disabled — this is the file's last test.
    await owner`alter table audit_log drop constraint ${owner(uniq!.conname)}`;
    await owner`alter table audit_log disable trigger audit_log_chain_biu`;
    // A second row at seq 2 — inserted AFTER the real rows, so its bigserial id is the largest. Under
    // (seq, id) order it sits immediately after the real seq-2 row: [1, 2real, 2forged, 3, 4].
    await withTenant(
      app,
      orgId,
      (tx) => tx`
      insert into audit_log (org_id, seq, action, prev_hash, row_hash)
      values (${orgId}, ${2}, ${"forged.fork"}, ${null}, ${Buffer.from(new Uint8Array(32).fill(7))})`,
    );
    // pageSize 2 → pages [1, 2real] | [2forged, 3] | [4]: 2forged is the FIRST row of page 2, so the carried
    // cursor (seq 2) catches it. A seq>2 keyset would have skipped straight to [3, 4].
    const result = await verifyAuditChainPaged(app, orgId, key, 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("duplicate_seq");
    expect(result.break.seq).toBe(2);
  });
});
