import { describe, expect, it } from "vitest";

import { importAuditKey } from "./audit";
import {
  ANCHOR_VERSION,
  anchorR2Key,
  anchorR2Prefix,
  buildAnchor,
  computeAnchorMac,
  parseAnchor,
  serializeAnchor,
  verifyAnchor,
  verifyChainAgainstAnchor,
  type AnchorPayload,
} from "./audit-anchor";
import type { StoredAuditRow } from "./audit-chain";

const ORG = crypto.randomUUID();
const OTHER_ORG = crypto.randomUUID();
const HEAD_HASH = new Uint8Array(32).fill(9);
const ANCHORED_AT = 1_700_000_000_000;

const key = () => importAuditKey(new Uint8Array(32).fill(7));

function row(seq: number, rowHash: Uint8Array): StoredAuditRow {
  return { orgId: ORG, seq, actor: null, action: "x", target: null, prevHash: null, rowHash };
}

describe("audit anchor format", () => {
  it("round-trips build -> serialize -> parse -> verify", async () => {
    const k = await key();
    const { serialized } = await buildAnchor(
      k,
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    expect(await verifyAnchor(k, serialized)).toBe(true);

    const { payload } = parseAnchor(serialized);
    expect(payload.version).toBe(ANCHOR_VERSION);
    expect(payload.orgId).toBe(ORG);
    expect(payload.seq).toBe(5);
    expect(payload.anchoredAt).toBe(ANCHORED_AT);
    expect(Buffer.from(payload.rowHash).equals(Buffer.from(HEAD_HASH))).toBe(true);
  });

  it("fails verification under a different key", async () => {
    const { serialized } = await buildAnchor(
      await key(),
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    const other = await importAuditKey(new Uint8Array(32).fill(8));
    expect(await verifyAnchor(other, serialized)).toBe(false);
  });

  it("fails verification when any payload field is tampered (MAC binds the whole head)", async () => {
    const k = await key();
    const { serialized } = await buildAnchor(
      k,
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    const obj = JSON.parse(serialized) as { seq: number };
    obj.seq = 6; // move the anchored seq but keep the original MAC
    expect(await verifyAnchor(k, JSON.stringify(obj))).toBe(false);
  });

  it("rejects a validly-MAC'd anchor of an unknown version", async () => {
    const k = await key();
    // A future v2 anchor with a CORRECT v2 MAC — the v1 verifier must still refuse it.
    const v2: AnchorPayload = {
      version: 2,
      orgId: ORG,
      seq: 5,
      rowHash: HEAD_HASH,
      anchoredAt: ANCHORED_AT,
    };
    const v2text = serializeAnchor(v2, await computeAnchorMac(k, v2));
    expect(await verifyAnchor(k, v2text)).toBe(false);
  });

  it("anchorR2Key is zero-padded so lexical order = numeric order", () => {
    expect(anchorR2Key(ORG, 5)).toBe(`audit-anchors/${ORG}/00000000000000000005.json`);
    expect(anchorR2Prefix(ORG)).toBe(`audit-anchors/${ORG}/`);
    expect(anchorR2Key(ORG, 5) < anchorR2Key(ORG, 42)).toBe(true);
    expect(anchorR2Key(ORG, 9) < anchorR2Key(ORG, 10)).toBe(true);
  });
});

describe("verifyChainAgainstAnchor", () => {
  it("passes when the live chain still holds the anchored head", async () => {
    const k = await key();
    const { serialized } = await buildAnchor(
      k,
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    const rows = [row(3, new Uint8Array(32).fill(1)), row(5, HEAD_HASH)];
    expect(await verifyChainAgainstAnchor(k, ORG, rows, serialized)).toEqual({ ok: true });
  });

  it("detects truncation below the anchored seq (head_below_anchor)", async () => {
    const k = await key();
    const { serialized } = await buildAnchor(
      k,
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    const rows = [row(1, new Uint8Array(32).fill(1)), row(3, new Uint8Array(32).fill(2))]; // max seq 3 < 5
    const res = await verifyChainAgainstAnchor(k, ORG, rows, serialized);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ kind: "head_below_anchor" });
  });

  it("detects a fork/rewrite at the anchored seq (hash_mismatch)", async () => {
    const k = await key();
    const { serialized } = await buildAnchor(
      k,
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    const rows = [row(5, new Uint8Array(32).fill(0xab))]; // seq present, different row_hash
    const res = await verifyChainAgainstAnchor(k, ORG, rows, serialized);
    expect(res).toMatchObject({ ok: false, kind: "hash_mismatch" });
  });

  it("rejects an anchor for a different org", async () => {
    const k = await key();
    const { serialized } = await buildAnchor(
      k,
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    const res = await verifyChainAgainstAnchor(k, OTHER_ORG, [row(5, HEAD_HASH)], serialized);
    expect(res).toMatchObject({ ok: false, kind: "wrong_org" });
  });

  it("does not accept a same-seq row from a DIFFERENT org as the anchored head", async () => {
    const k = await key();
    const { serialized } = await buildAnchor(
      k,
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    // A row at seq 5 with the matching hash but belonging to OTHER_ORG must NOT satisfy ORG's anchor.
    const crossOrgRow: StoredAuditRow = {
      orgId: OTHER_ORG,
      seq: 5,
      actor: null,
      action: "x",
      target: null,
      prevHash: null,
      rowHash: HEAD_HASH,
    };
    const res = await verifyChainAgainstAnchor(k, ORG, [crossOrgRow], serialized);
    expect(res).toMatchObject({ ok: false, kind: "head_below_anchor" });
  });

  it("rejects an unsupported anchor version (bad_anchor)", async () => {
    const k = await key();
    const v2: AnchorPayload = {
      version: 2,
      orgId: ORG,
      seq: 5,
      rowHash: HEAD_HASH,
      anchoredAt: ANCHORED_AT,
    };
    const v2text = serializeAnchor(v2, await computeAnchorMac(k, v2));
    const res = await verifyChainAgainstAnchor(k, ORG, [row(5, HEAD_HASH)], v2text);
    expect(res).toMatchObject({ ok: false, kind: "bad_anchor" });
  });

  it("rejects an anchor whose MAC doesn't verify (forged anchor)", async () => {
    const k = await key();
    const { serialized } = await buildAnchor(
      k,
      { orgId: ORG, seq: 5, rowHash: HEAD_HASH },
      ANCHORED_AT,
    );
    const obj = JSON.parse(serialized) as { mac: string };
    obj.mac = Buffer.from(new Uint8Array(32).fill(0)).toString("base64");
    const res = await verifyChainAgainstAnchor(k, ORG, [row(5, HEAD_HASH)], JSON.stringify(obj));
    expect(res).toMatchObject({ ok: false, kind: "bad_mac" });
  });

  it("rejects a malformed anchor object (bad_anchor)", async () => {
    const k = await key();
    const res = await verifyChainAgainstAnchor(k, ORG, [row(5, HEAD_HASH)], "not json at all");
    expect(res).toMatchObject({ ok: false, kind: "bad_anchor" });
  });
});
