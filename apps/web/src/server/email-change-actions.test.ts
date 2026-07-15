import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifySession,
  start,
  commit,
  getEmailChangeBinding,
  remintSessionForProfile,
  appendAuthAuditEntry,
} = vi.hoisted(() => ({
  verifySession: vi.fn(),
  start: vi.fn(),
  commit: vi.fn(),
  getEmailChangeBinding: vi.fn(),
  remintSessionForProfile: vi.fn(),
  appendAuthAuditEntry: vi.fn(),
}));

vi.mock("./session", () => ({ verifySession }));
vi.mock("./env", () => ({
  getEmailChangeBinding: () => getEmailChangeBinding(),
  getAuditChainKey: async () => "AA".repeat(32),
}));
vi.mock("./session-remint", () => ({ remintSessionForProfile }));
vi.mock("./action-log", () => ({ logActionError: vi.fn() }));

// The audit path — mocked to a no-op so tests focus on the ceremony orchestration, not the hash chain.
vi.mock("@webhook-co/db", () => ({
  appendAuthAuditEntry,
  personalOrgId: (id: string) => `personal_${id}`,
  withTenant: async (_app: unknown, _org: string, fn: (tx: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("./db", () => ({ withTenantDb: async (fn: (app: unknown) => Promise<unknown>) => fn({}) }));
vi.mock("@webhook-co/shared", () => ({
  formatAuditActor: () => "user:u_1",
  userActor: (id: string) => ({ kind: "user", id }),
}));
vi.mock("@webhook-co/shared/audit", () => ({ importAuditKey: async () => ({}) as CryptoKey }));
vi.mock("@webhook-co/shared/bytes", () => ({ b64ToBytes: () => new Uint8Array(32) }));

import { commitEmailChangeAction, startEmailChangeAction } from "./email-change-actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue({
    userId: "u_1",
    orgId: "o_1",
    user: { name: "Dana", email: "old@e.test", image: null },
  });
  remintSessionForProfile.mockResolvedValue(undefined);
  appendAuthAuditEntry.mockResolvedValue(undefined);
  getEmailChangeBinding.mockReturnValue({ start, commit });
  start.mockResolvedValue({ ok: true });
  commit.mockResolvedValue({ ok: true, oldEmail: "old@e.test", newEmail: "new@e.test" });
});

describe("startEmailChangeAction", () => {
  it("RPCs the binding with the caller's OWN userId and the new email", async () => {
    expect(await startEmailChangeAction(form({ email: "new@e.test" }))).toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith("u_1", "new@e.test");
  });

  it("rejects an empty email without calling the RPC", async () => {
    expect((await startEmailChangeAction(form({ email: "  " }))).ok).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it("returns unavailable (never throws) when the binding is unbound", async () => {
    getEmailChangeBinding.mockReturnValue(undefined);
    const res = await startEmailChangeAction(form({ email: "new@e.test" }));
    expect(res.ok).toBe(false);
  });

  it("returns unavailable when the RPC throws (deploy window / transient)", async () => {
    start.mockRejectedValueOnce(new Error("method not found"));
    expect((await startEmailChangeAction(form({ email: "new@e.test" }))).ok).toBe(false);
  });
});

describe("commitEmailChangeAction", () => {
  it("on success: re-mints THIS session with the new email and writes an audit row", async () => {
    const res = await commitEmailChangeAction(form({ code: "123456" }));
    expect(res).toEqual({ ok: true, oldEmail: "old@e.test", newEmail: "new@e.test" });
    expect(commit).toHaveBeenCalledWith("u_1", "123456");
    // The current browser's cookie is re-minted with the NEW email (not the old one).
    expect(remintSessionForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new@e.test" }),
    );
    // A PII-free email_changed audit row was appended to the personal-org chain.
    expect(appendAuthAuditEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ eventType: "email_changed", targetId: "u_1", metadata: {} }),
    );
  });

  it("on a failed commit: returns the result and does NOT re-mint or audit", async () => {
    commit.mockResolvedValue({
      ok: false,
      error: "That code isn't right.",
      reason: "invalid_code",
    });
    const res = await commitEmailChangeAction(form({ code: "000000" }));
    expect(res.ok).toBe(false);
    expect(remintSessionForProfile).not.toHaveBeenCalled();
    expect(appendAuthAuditEntry).not.toHaveBeenCalled();
  });

  it("still succeeds even if the (best-effort) audit append throws", async () => {
    appendAuthAuditEntry.mockRejectedValueOnce(new Error("chain locked"));
    const res = await commitEmailChangeAction(form({ code: "123456" }));
    expect(res.ok).toBe(true); // the email already changed; the audit is best-effort
    expect(remintSessionForProfile).toHaveBeenCalled();
  });

  it("rejects an empty code without calling the RPC", async () => {
    expect((await commitEmailChangeAction(form({ code: "" }))).ok).toBe(false);
    expect(commit).not.toHaveBeenCalled();
  });
});
