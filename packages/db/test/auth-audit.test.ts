import { randomUUID } from "node:crypto";

import { importAuditKey } from "@webhook-co/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  appendAuthAuditEntry,
  listAuthAuditEntries,
  readAuthAuditChain,
  readAuthAuditChainPage,
  verifyAuthAuditChain,
  verifyAuthAuditChainPaged,
  verifyAuthAuditRowHash,
  type StoredAuthAuditRow,
} from "../src/auth-audit";
import { createClient, withTenant, type Sql } from "../src/client";
import { DB_ROLES } from "../src/constants";
import { setupSchema } from "./migrate";
import { startEphemeralPostgres, type EphemeralPostgres } from "./pg";
import { setupHookTimeoutMs } from "./pg-timing";

// The aae1 auth-audit append-service against a REAL Postgres: the per-org advisory lock, the
// chain trigger's structural enforcement, the jsonb round-trip (geo/metadata must canonicalize back
// to the SAME bytes after jsonb storage reorders keys), RLS isolation, and immutability — all end to
// end. The HMAC key is supplied from a binding, never the DB role (ADR-0004).

let pg: EphemeralPostgres;
let app: Sql;
let owner: Sql; // table owner — ALTERs schema (constraints/triggers) the app role can't
let admin: Sql; // bootstrap superuser — BYPASSES RLS, so it can remove a forged WORM row during cleanup
let key: CryptoKey;

async function seedOrg(slug: string): Promise<string> {
  const orgId = randomUUID();
  await withTenant(app, orgId, async (tx) => {
    await tx`insert into orgs (id, slug, name) values (${orgId}, ${slug}, ${slug})`;
  });
  return orgId;
}

/** Walk a chain: every row_hash recomputes, seq is contiguous from 1, prev_hash links the prior. */
async function verifyChain(rows: readonly StoredAuthAuditRow[]): Promise<boolean> {
  let prev: Uint8Array | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.seq !== i + 1) return false;
    if (prev === null ? r.prevHash !== null : Buffer.compare(r.prevHash!, prev) !== 0) return false;
    if (!(await verifyAuthAuditRowHash(key, r.prevHash, r, r.rowHash))) return false;
    prev = r.rowHash;
  }
  return true;
}

beforeAll(async () => {
  pg = await startEphemeralPostgres();
  await setupSchema(pg);
  app = createClient(pg.urlFor({ role: DB_ROLES.app }));
  owner = createClient(pg.urlFor({ role: DB_ROLES.owner }));
  admin = createClient(pg.providerUrl);
  key = await importAuditKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 11) % 256)));
}, setupHookTimeoutMs());

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await admin?.end();
  await pg?.stop();
});

describe("appendAuthAuditEntry (aae1 append-service)", () => {
  it("writes a genesis row at seq 1 with a null prev_hash, and it verifies", async () => {
    const orgId = await seedOrg(`aae-genesis-${randomUUID().slice(0, 6)}`);
    const written = await withTenant(app, orgId, (tx) =>
      appendAuthAuditEntry(tx, key, { orgId, actor: "user_1", eventType: "login" }),
    );
    expect(written.seq).toBe(1);
    expect(written.prevHash).toBeNull();
    expect(written.rowHash.length).toBe(32);

    const chain = await withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId));
    expect(chain.map((r) => r.seq)).toEqual([1]);
    expect(await verifyChain(chain)).toBe(true);
  });

  it("chains TWO events in ONE transaction (the mint tx: grant_created + key_minted)", async () => {
    const orgId = await seedOrg(`aae-mint-tx-${randomUUID().slice(0, 6)}`);
    await withTenant(app, orgId, async (tx) => {
      await appendAuthAuditEntry(tx, key, {
        orgId,
        actor: "user_1",
        eventType: "grant_created",
        targetId: "grant_1",
      });
      await appendAuthAuditEntry(tx, key, {
        orgId,
        actor: "user_1",
        eventType: "key_minted",
        targetId: "key_1",
      });
    });

    const chain = await withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId));
    expect(chain.map((r) => r.seq)).toEqual([1, 2]);
    expect(chain.map((r) => r.eventType)).toEqual(["grant_created", "key_minted"]);
    expect(await verifyChain(chain)).toBe(true);
  });

  it("round-trips jsonb geo/metadata so the canon reproduces after jsonb reorders keys", async () => {
    const orgId = await seedOrg(`aae-jsonb-${randomUUID().slice(0, 6)}`);
    // Keys deliberately NOT in sorted order; jsonb storage will reorder them. The canon's sorted-key
    // serialization must make readback recompute to the SAME row_hash.
    await withTenant(app, orgId, (tx) =>
      appendAuthAuditEntry(tx, key, {
        orgId,
        actor: "user_1",
        eventType: "grant_created",
        targetId: "grant_geo",
        ip: "203.0.113.9",
        geo: { region: "CA", country: "US", city: "SF" },
        metadata: {
          scopes: ["events:read", "events:replay"],
          device: "cli",
          nested: { z: 1, a: 2 },
        },
      }),
    );
    const chain = await withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId));
    expect(chain[0]!.ip).toBe("203.0.113.9");
    expect(await verifyChain(chain)).toBe(true); // recompute over READBACK jsonb still matches
  });

  it("serializes concurrent appends in one org under the advisory lock (no seq fork)", async () => {
    const orgId = await seedOrg(`aae-concurrent-${randomUUID().slice(0, 6)}`);
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withTenant(app, orgId, (tx) =>
          appendAuthAuditEntry(tx, key, {
            orgId,
            actor: `u${i}`,
            eventType: "reauth",
            targetId: `t_${i}`,
          }),
        ),
      ),
    );
    const chain = await withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId));
    expect(chain.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(await verifyChain(chain)).toBe(true);
  });

  it("keeps per-org chains independent (RLS: each starts at its own genesis)", async () => {
    const orgA = await seedOrg(`aae-iso-a-${randomUUID().slice(0, 6)}`);
    const orgB = await seedOrg(`aae-iso-b-${randomUUID().slice(0, 6)}`);
    await withTenant(app, orgA, (tx) =>
      appendAuthAuditEntry(tx, key, { orgId: orgA, actor: "u", eventType: "login" }),
    );
    await withTenant(app, orgB, (tx) =>
      appendAuthAuditEntry(tx, key, { orgId: orgB, actor: "u", eventType: "login" }),
    );
    await withTenant(app, orgB, (tx) =>
      appendAuthAuditEntry(tx, key, {
        orgId: orgB,
        actor: "u",
        eventType: "key_minted",
        targetId: "k",
      }),
    );

    const chainA = await withTenant(app, orgA, (tx) => readAuthAuditChain(tx, orgA));
    const chainB = await withTenant(app, orgB, (tx) => readAuthAuditChain(tx, orgB));
    expect(chainA.map((r) => r.seq)).toEqual([1]); // org A cannot see org B's rows
    expect(chainB.map((r) => r.seq)).toEqual([1, 2]);
    expect(await verifyChain(chainA)).toBe(true);
    expect(await verifyChain(chainB)).toBe(true);
  });

  it("is append-only for webhook_app: UPDATE/DELETE are denied at the grant layer", async () => {
    // webhook_app holds only SELECT+INSERT (migration 0013), so the app role is denied UPDATE/DELETE
    // before the immutability trigger even fires — append-only enforced at the privilege layer. The
    // trigger is defense-in-depth for any privileged role and is exercised against the cluster
    // superuser in rls.test.ts; here we assert the operative defense for the role the service uses.
    const orgId = await seedOrg(`aae-immutable-${randomUUID().slice(0, 6)}`);
    await withTenant(app, orgId, (tx) =>
      appendAuthAuditEntry(tx, key, { orgId, actor: "u", eventType: "login" }),
    );
    await expect(
      withTenant(
        app,
        orgId,
        (tx) => tx`update auth_audit_event set actor = 'x' where org_id = ${orgId}`,
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(app, orgId, (tx) => tx`delete from auth_audit_event where org_id = ${orgId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("detects tampering: a recompute over an edited row fails verification", async () => {
    const orgId = await seedOrg(`aae-tamper-${randomUUID().slice(0, 6)}`);
    await withTenant(app, orgId, async (tx) => {
      await appendAuthAuditEntry(tx, key, {
        orgId,
        actor: "u",
        eventType: "grant_created",
        targetId: "g",
      });
      await appendAuthAuditEntry(tx, key, {
        orgId,
        actor: "u",
        eventType: "key_minted",
        targetId: "k",
      });
    });
    const chain = await withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId));
    const tampered = chain.map((r) => (r.seq === 2 ? { ...r, targetId: "k_evil" } : r));
    expect(await verifyChain(tampered)).toBe(false);
  });

  it("canonicalizes a non-canonical IP so the row still verifies after inet normalization", async () => {
    // ip is stored as inet (postgres compresses IPv6, drops leading zeros). The hash must be over the
    // SAME normalized form the column stores & reads back, else a legitimately-written row would fail
    // its own verifier. We pass an uncompressed IPv6 + a leading-zero IPv4 and expect a clean chain.
    const orgId = await seedOrg(`aae-ip-canon-${randomUUID().slice(0, 6)}`);
    await withTenant(app, orgId, async (tx) => {
      await appendAuthAuditEntry(tx, key, {
        orgId,
        actor: "u",
        eventType: "login",
        ip: "2001:0db8:0000:0000:0000:0000:0000:0001",
      });
      await appendAuthAuditEntry(tx, key, {
        orgId,
        actor: "u",
        eventType: "reauth",
        ip: "192.168.001.001",
      });
    });
    const chain = await withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId));
    expect(chain.map((r) => r.ip)).toEqual(["2001:db8::1", "192.168.1.1"]); // postgres-canonical
    expect(await verifyChain(chain)).toBe(true); // hash matches the normalized, stored form
  });

  it("rejects an invalid IP at write (fail-loud, never a silent unverifiable row)", async () => {
    const orgId = await seedOrg(`aae-ip-bad-${randomUUID().slice(0, 6)}`);
    await expect(
      withTenant(app, orgId, (tx) =>
        appendAuthAuditEntry(tx, key, { orgId, actor: "u", eventType: "login", ip: "not-an-ip" }),
      ),
    ).rejects.toThrow();
  });
});

// The chain WALKER (Lane 2.10). Until now aae1 had only a per-ROW verifier — enough to check one entry in
// isolation, and useless against the attacks a chain exists to detect. A deleted row leaves a seq GAP; a
// rewritten history leaves a BROKEN LINK; a forked chain leaves a DUPLICATE seq. None of those are visible
// one row at a time, which is exactly why the walker has to exist.
describe("verifyAuthAuditChain", () => {
  async function seedChain(slug: string, n: number): Promise<string> {
    const orgId = await seedOrg(slug);
    for (let i = 0; i < n; i++) {
      await withTenant(app, orgId, (tx) =>
        appendAuthAuditEntry(tx, key, {
          orgId,
          actor: `u_${i}`,
          eventType: "invite_created",
          targetId: `inv_${i}`,
          metadata: { role: "member" },
        }),
      );
    }
    return orgId;
  }

  const read = (orgId: string) => withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId));

  it("accepts an intact chain, and reports how many rows it actually recomputed", async () => {
    const orgId = await seedChain(`aae-ok-${randomUUID().slice(0, 6)}`, 4);
    const result = await verifyAuthAuditChain(key, orgId, await read(orgId));
    expect(result).toEqual({ ok: true, rowsVerified: 4 });
  });

  it("an empty chain is vacuously valid", async () => {
    const orgId = await seedOrg(`aae-empty-${randomUUID().slice(0, 6)}`);
    expect(await verifyAuthAuditChain(key, orgId, [])).toEqual({ ok: true, rowsVerified: 0 });
  });

  it("catches a DELETED row — the gap a per-row verifier cannot see", async () => {
    const orgId = await seedChain(`aae-gap-${randomUUID().slice(0, 6)}`, 4);
    const rows = await read(orgId);
    const missingMiddle = rows.filter((r) => r.seq !== 3);

    const result = await verifyAuthAuditChain(key, orgId, missingMiddle);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.kind).toBe("seq_gap");
      expect(result.break.seq).toBe(4); // the seq AFTER the hole
      expect(result.rowsVerified).toBe(2); // …and it says how far it got
    }
  });

  it("catches a REWRITTEN row (its hash no longer recomputes)", async () => {
    const orgId = await seedChain(`aae-tamper-${randomUUID().slice(0, 6)}`, 3);
    const rows = await read(orgId);
    // Someone edits history: the event type is changed, the stored row_hash is not.
    const tampered = rows.map((r) =>
      r.seq === 2 ? { ...r, eventType: "member_removed" as const } : r,
    );

    const result = await verifyAuthAuditChain(key, orgId, tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.kind).toBe("hash_mismatch");
      expect(result.break.seq).toBe(2);
    }
  });

  it("catches a genesis row carrying a prev_hash (it must link to nothing)", async () => {
    const orgId = await seedChain(`aae-genesis-${randomUUID().slice(0, 6)}`, 2);
    const rows = await read(orgId);
    // Someone grafts the chain onto an earlier, hidden history.
    const grafted = rows.map((r) =>
      r.seq === 1 ? { ...r, prevHash: new Uint8Array(32).fill(7) } : r,
    );

    const result = await verifyAuthAuditChain(key, orgId, grafted);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.kind).toBe("bad_genesis_prev_hash");
      expect(result.break.seq).toBe(1);
      expect(result.rowsVerified).toBe(0); // nothing before it was trustworthy
    }
  });

  it("catches a BROKEN LINK — seqs stay contiguous but a row no longer points at its parent", async () => {
    // The subtle one: nothing is missing and nothing is duplicated, so only the LINK reveals the edit.
    const orgId = await seedChain(`aae-link-${randomUUID().slice(0, 6)}`, 3);
    const rows = await read(orgId);
    const relinked = rows.map((r) =>
      r.seq === 3 ? { ...r, prevHash: new Uint8Array(32).fill(1) } : r,
    );

    const result = await verifyAuthAuditChain(key, orgId, relinked);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.break.kind).toBe("broken_link");
      expect(result.break.seq).toBe(3);
      expect(result.rowsVerified).toBe(2); // rows 1–2 verified before the break
    }
  });

  it("catches a NULL prev_hash on a non-genesis row (an unlinked row is not a chain)", async () => {
    const orgId = await seedChain(`aae-null-${randomUUID().slice(0, 6)}`, 2);
    const rows = await read(orgId);
    const unlinked = rows.map((r) => (r.seq === 2 ? { ...r, prevHash: null } : r));

    const result = await verifyAuthAuditChain(key, orgId, unlinked);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.break.kind).toBe("broken_link");
  });

  it("catches a FORKED chain (a duplicate seq)", async () => {
    const orgId = await seedChain(`aae-fork-${randomUUID().slice(0, 6)}`, 2);
    const rows = await read(orgId);
    const forked = [...rows, { ...rows[1]!, targetId: "inv_evil" }];

    const result = await verifyAuthAuditChain(key, orgId, forked);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.break.kind).toBe("duplicate_seq");
  });

  it("catches a chain that does not start at seq 1 (truncated from the front)", async () => {
    const orgId = await seedChain(`aae-trunc-${randomUUID().slice(0, 6)}`, 3);
    const rows = (await read(orgId)).filter((r) => r.seq !== 1);

    const result = await verifyAuthAuditChain(key, orgId, rows);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.break.kind).toBe("bad_genesis_seq");
  });

  it("refuses rows belonging to ANOTHER org", async () => {
    const a = await seedChain("aae-org-a", 1);
    const b = await seedOrg(`aae-org-b-${randomUUID().slice(0, 6)}`);
    const result = await verifyAuthAuditChain(key, b, await read(a));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.break.kind).toBe("wrong_org");
  });

  it("a chain verified with the WRONG key does not pass", async () => {
    const orgId = await seedChain(`aae-wrongkey-${randomUUID().slice(0, 6)}`, 2);
    const other = await importAuditKey(new Uint8Array(32).fill(9));
    const result = await verifyAuthAuditChain(other, orgId, await read(orgId));
    expect(result.ok).toBe(false);
  });
});

// Streaming verification (#663) — the same OOM fix #636 shipped for the wha1 chain, now for aae1. The paged
// reader keysets on the COMPOUND (seq, id) so a forked-seq tamper can't slip past a page boundary, and the
// first page has NO lower bound so a forged pre-genesis row (seq <= 0) is seen exactly as the whole-chain
// verifier would. The CPU-bound HMAC walk runs BETWEEN reads, each page in its own short transaction.
describe("verifyAuthAuditChainPaged (streaming verification, #663)", () => {
  async function seedChain(orgId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await withTenant(app, orgId, (tx) =>
        appendAuthAuditEntry(tx, key, {
          orgId,
          actor: i % 2 === 0 ? `u_${i}` : "system",
          eventType: "invite_created",
          targetId: `inv_${i}`,
          metadata: { role: "member" },
        }),
      );
    }
  }

  it("reads a page keyed on the compound (seq, id), returning the tail cursor to resume after", async () => {
    const orgId = await seedOrg(`aae-page-read-${randomUUID().slice(0, 6)}`);
    await seedChain(orgId, 5);
    const first = await withTenant(app, orgId, (tx) => readAuthAuditChainPage(tx, orgId, null, 2));
    expect(first.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(first.nextCursor?.seq).toBe(2);
    expect(typeof first.nextCursor?.id).toBe("string");

    const second = await withTenant(app, orgId, (tx) =>
      readAuthAuditChainPage(tx, orgId, first.nextCursor, 2),
    );
    expect(second.rows.map((r) => r.seq)).toEqual([3, 4]);
    const third = await withTenant(app, orgId, (tx) =>
      readAuthAuditChainPage(tx, orgId, second.nextCursor, 2),
    );
    expect(third.rows.map((r) => r.seq)).toEqual([5]);
  });

  it("verifies an intact chain across MANY pages (a tiny pageSize forces the boundaries)", async () => {
    const orgId = await seedOrg(`aae-paged-ok-${randomUUID().slice(0, 6)}`);
    await seedChain(orgId, 5);
    // pageSize 2 → pages [1,2] [3,4] [5]: the prev_hash link at seq 3 and seq 5 is checked across a boundary.
    const result = await verifyAuthAuditChainPaged(app, orgId, key, 2);
    expect(result.ok).toBe(true);
    expect(result.rowsVerified).toBe(5);
  });

  it("matches the whole-chain verifier exactly (same ok + rowsVerified) at any pageSize", async () => {
    const orgId = await seedOrg(`aae-paged-match-${randomUUID().slice(0, 6)}`);
    await seedChain(orgId, 7);
    const whole = await withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId)).then((rows) =>
      verifyAuthAuditChain(key, orgId, rows),
    );
    for (const pageSize of [1, 3, 7, 100]) {
      const paged = await verifyAuthAuditChainPaged(app, orgId, key, pageSize);
      expect(paged).toEqual(whole);
    }
  });

  it("still catches tampering (a wrong key) through the paged reader", async () => {
    const orgId = await seedOrg(`aae-paged-key-${randomUUID().slice(0, 6)}`);
    await seedChain(orgId, 4);
    const wrongKey = await importAuditKey(new Uint8Array(32).fill(9));
    const result = await verifyAuthAuditChainPaged(app, orgId, wrongKey, 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("hash_mismatch");
    expect(result.break.seq).toBe(1); // the genesis row already fails to recompute
  });

  it("an empty chain is vacuously valid (no page read past the first)", async () => {
    const orgId = await seedOrg(`aae-paged-empty-${randomUUID().slice(0, 6)}`);
    const result = await verifyAuthAuditChainPaged(app, orgId, key, 10);
    expect(result).toEqual({ ok: true, rowsVerified: 0 });
  });

  it("rejects a non-positive pageSize rather than silently certifying an unread chain", async () => {
    const orgId = await seedOrg(`aae-paged-badsize-${randomUUID().slice(0, 6)}`);
    await seedChain(orgId, 2);
    // A pageSize <= 0 would read `limit 0`, get an empty first page, and FALSELY report ok — refuse it.
    await expect(verifyAuthAuditChainPaged(app, orgId, key, 0)).rejects.toBeInstanceOf(RangeError);
    await expect(verifyAuthAuditChainPaged(app, orgId, key, -5)).rejects.toBeInstanceOf(RangeError);
  });

  // A forged pre-genesis row at seq 0 is a valid unique (seq 0 is otherwise unused) but an ILLEGAL genesis.
  // The whole-chain verifier flags bad_genesis_seq; a seq>0 first page would skip it and report intact. The
  // no-lower-bound first page reads from the true minimum, so it is caught at the page boundary.
  it("catches a forged pre-genesis row (seq 0) a seq>0 first page would skip", async () => {
    const orgId = await seedOrg(`aae-paged-genesis-${randomUUID().slice(0, 6)}`);
    await seedChain(orgId, 3); // real rows at seq 1,2,3
    // Forge the row past the append-validation trigger — the DB-side tamper the verifier exists to detect.
    // owner does the DDL (disable trigger); the insert itself runs under the org's RLS context via app.
    await owner`alter table auth_audit_event disable trigger auth_audit_event_chain_biu`;
    try {
      await withTenant(
        app,
        orgId,
        (tx) => tx`
        insert into auth_audit_event (org_id, seq, event_type, prev_hash, row_hash)
        values (${orgId}, ${0}, ${"login"}, ${null}, ${Buffer.from(new Uint8Array(32))})`,
      );
    } finally {
      await owner`alter table auth_audit_event enable trigger auth_audit_event_chain_biu`;
    }
    // pageSize 2 → first page (no lower bound) is [seq0, seq1]; the true minimum is seen.
    const result = await verifyAuthAuditChainPaged(app, orgId, key, 2);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.break.kind).toBe("bad_genesis_seq");
    expect(result.break.seq).toBe(0);
  });

  // A seq-only keyset skips a FORKED duplicate seq whenever the page boundary falls between the two rows
  // sharing that seq — losing the whole-chain verifier's duplicate_seq detection. The compound (seq, id)
  // keyset never skips a boundary row. This forces exactly that boundary by temporarily bypassing both DB
  // guards (the unique(org_id, seq) constraint + the append trigger) — the compromised-DB state the app-side
  // verifier exists to catch — then RESTORES them so a later-added test never runs on weakened schema.
  it("catches a forked duplicate seq split across a page boundary (compound (seq, id) keyset)", async () => {
    const orgId = await seedOrg(`aae-paged-fork-${randomUUID().slice(0, 6)}`);
    await seedChain(orgId, 4); // real rows at seq 1,2,3,4
    const [uniq] = await owner<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid = 'auth_audit_event'::regclass and contype = 'u'`;
    await owner`alter table auth_audit_event drop constraint ${owner(uniq!.conname)}`;
    await owner`alter table auth_audit_event disable trigger auth_audit_event_chain_biu`;
    try {
      // A second row at seq 2 — inserted AFTER the real rows, so its bigserial id is the largest. Under
      // (seq, id) order it sits immediately after the real seq-2 row: [1, 2real, 2forged, 3, 4].
      await withTenant(
        app,
        orgId,
        (tx) => tx`
        insert into auth_audit_event (org_id, seq, event_type, target_id, prev_hash, row_hash)
        values (${orgId}, ${2}, ${"login"}, ${"forged_fork"}, ${null}, ${Buffer.from(new Uint8Array(32).fill(7))})`,
      );
      // pageSize 2 → pages [1, 2real] | [2forged, 3] | [4]: 2forged is the FIRST row of page 2, so the carried
      // cursor (seq 2) catches it. A seq>2 keyset would have skipped straight to [3, 4].
      const result = await verifyAuthAuditChainPaged(app, orgId, key, 2);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.break.kind).toBe("duplicate_seq");
      expect(result.break.seq).toBe(2);
    } finally {
      // Restore the schema: drop the forged row (via the superuser, which bypasses RLS — auth_audit_event is
      // WORM and has no DELETE policy — with the no_delete trigger temporarily off), then re-enable the
      // append trigger and re-add the unique constraint (which holds again once the duplicate is gone).
      await owner`alter table auth_audit_event disable trigger auth_audit_event_no_delete`;
      await admin`delete from auth_audit_event where target_id = ${"forged_fork"}`;
      await owner`alter table auth_audit_event enable trigger auth_audit_event_no_delete`;
      await owner`alter table auth_audit_event enable trigger auth_audit_event_chain_biu`;
      await owner`alter table auth_audit_event add constraint ${owner(uniq!.conname)} unique (org_id, seq)`;
    }
  });
});

describe("listAuthAuditEntries", () => {
  it("pages newest-first without skipping or repeating, and never returns ip/geo", async () => {
    const orgId = await seedOrg(`aae-list-${randomUUID().slice(0, 6)}`);
    for (let i = 0; i < 3; i++) {
      await withTenant(app, orgId, (tx) =>
        appendAuthAuditEntry(tx, key, {
          orgId,
          actor: "u_1",
          eventType: "member_role_changed",
          targetId: `u_${i}`,
          ip: "203.0.113.4",
          geo: { country: "PT" },
          metadata: { from: "member", to: "admin" },
        }),
      );
    }

    const first = await withTenant(app, orgId, (tx) => listAuthAuditEntries(tx, { limit: 2 }));
    expect(first.items.map((i) => i.seq)).toEqual([3, 2]);
    expect(first.items[0]?.eventType).toBe("member_role_changed");
    expect(first.items[0]?.metadata).toEqual({ from: "member", to: "admin" });
    // ip/geo are hashed INTO the chain (a verify still covers them) but must never reach the browser.
    expect(first.items[0]).not.toHaveProperty("ip");
    expect(first.items[0]).not.toHaveProperty("geo");

    const second = await withTenant(app, orgId, (tx) =>
      listAuthAuditEntries(tx, { limit: 2, afterSeq: first.nextSeq }),
    );
    expect(second.items.map((i) => i.seq)).toEqual([1]);
    expect(second.nextSeq).toBeNull();
  });

  it("is RLS-scoped — one org never sees another's governance events", async () => {
    const a = await seedOrg(`aae-list-a-${randomUUID().slice(0, 6)}`);
    const b = await seedOrg(`aae-list-b-${randomUUID().slice(0, 6)}`);
    await withTenant(app, a, (tx) =>
      appendAuthAuditEntry(tx, key, { orgId: a, actor: "u", eventType: "key_minted" }),
    );
    const inB = await withTenant(app, b, (tx) => listAuthAuditEntries(tx, { limit: 50 }));
    expect(inB.items).toEqual([]);
  });
});
