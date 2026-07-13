import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAccess = vi.fn();
vi.mock("./org-access", () => ({ requireOrgAccess: () => requireOrgAccess() }));

const readAuditChain = vi.fn(async () => [{ seq: 1 }]);
vi.mock("@webhook-co/db/audit-append", () => ({
  readAuditChain: (...a: unknown[]) => readAuditChain(...a),
}));
vi.mock("@webhook-co/db/client", () => ({
  withTenant: (_app: unknown, _org: string, fn: (tx: unknown) => unknown) => fn({}),
}));

const verifyAuditChain = vi.fn(async () => ({ ok: true, rowsVerified: 1 }));
// PARTIAL mock: stub only verifyAuditChain (it needs WebCrypto + a real key) and keep the REAL
// isAuditReaderRole. A gate tested against a hand-rolled copy of itself is green and worthless — the real
// predicate could drift to `true` for a member and every test here would still pass.
vi.mock("@webhook-co/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@webhook-co/shared")>()),
  verifyAuditChain: (...a: unknown[]) => verifyAuditChain(...a),
}));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));
vi.mock("./env", () => ({ getAuditChainKey: async () => "AA".repeat(32) }));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

const loadAudit = vi.fn(async () => ({ status: "ok", items: [], nextSeq: null }));
vi.mock("./audit", () => ({ loadAudit: (...a: unknown[]) => loadAudit(...a) }));

import { loadMoreAuditAction, verifyAuditChainAction } from "./audit-actions";

function form(afterSeq: string): FormData {
  const fd = new FormData();
  fd.set("afterSeq", afterSeq);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgAccess.mockResolvedValue({ userId: "u_1", orgId: "org_1", role: "owner" });
  verifyAuditChain.mockResolvedValue({ ok: true, rowsVerified: 1 });
  loadAudit.mockResolvedValue({ status: "ok", items: [], nextSeq: null });
});

describe("the audit role gate", () => {
  // The mint ceiling already refuses a MEMBER an `audit:read` key ("reading the chain is an administrative
  // act"). If the session surface didn't enforce the same rule, that ceiling would be decorative: the member
  // would just read the identical chain in the browser. These pin the two surfaces in agreement.
  it("REFUSES a plain member — and reads nothing", async () => {
    requireOrgAccess.mockResolvedValueOnce({ userId: "u_m", orgId: "org_1", role: "member" });
    expect(await verifyAuditChainAction()).toEqual({ status: "forbidden" });
    expect(readAuditChain).not.toHaveBeenCalled();
    expect(verifyAuditChain).not.toHaveBeenCalled();
  });

  it("REFUSES a plain member the list too", async () => {
    requireOrgAccess.mockResolvedValueOnce({ userId: "u_m", orgId: "org_1", role: "member" });
    expect(await loadMoreAuditAction(form("5"))).toEqual({ status: "forbidden" });
    expect(loadAudit).not.toHaveBeenCalled();
  });

  it("allows an admin", async () => {
    requireOrgAccess.mockResolvedValueOnce({ userId: "u_a", orgId: "org_1", role: "admin" });
    expect(await verifyAuditChainAction()).toMatchObject({ status: "ok" });
  });
});

describe("verifyAuditChainAction", () => {
  it("walks the whole chain and reports the verdict", async () => {
    const res = await verifyAuditChainAction();
    expect(res).toEqual({ status: "ok", verification: { ok: true, rowsVerified: 1 } });
    expect(readAuditChain).toHaveBeenCalled();
  });

  it("reports a BREAK verbatim — with where it broke, not a reassuring boolean", async () => {
    verifyAuditChain.mockResolvedValueOnce({
      ok: false,
      rowsVerified: 3,
      break: { kind: "hash_mismatch", seq: 4, detail: "row 4 does not recompute" },
    });
    const res = await verifyAuditChainAction();
    expect(res).toMatchObject({
      status: "ok",
      verification: { ok: false, break: { kind: "hash_mismatch", seq: 4 } },
    });
  });

  it("returns an error result rather than throwing when the read fails", async () => {
    readAuditChain.mockRejectedValueOnce(new Error("db down"));
    expect(await verifyAuditChainAction()).toEqual({ status: "error" });
  });
});

describe("loadMoreAuditAction", () => {
  it("pages from the given seq", async () => {
    await loadMoreAuditAction(form("42"));
    expect(loadAudit).toHaveBeenCalledWith("org_1", 42);
  });

  it("refuses a junk cursor without touching the DB", async () => {
    const res = await loadMoreAuditAction(form("not-a-number"));
    expect(res).toEqual({ status: "ok", result: { status: "error" } });
    expect(loadAudit).not.toHaveBeenCalled();
  });
});
