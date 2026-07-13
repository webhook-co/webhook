import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAccess = vi.fn();
vi.mock("@/server/org-access", () => ({ requireOrgAccess: () => requireOrgAccess() }));

const loadAudit = vi.fn(async () => ({ status: "ok", items: [], nextSeq: null }));
const loadAuthAudit = vi.fn(async () => ({ status: "ok", items: [], nextSeq: null }));
vi.mock("@/server/audit", () => ({
  loadAudit: (...a: unknown[]) => loadAudit(...a),
  loadAuthAudit: (...a: unknown[]) => loadAuthAudit(...a),
}));

vi.mock("@/server/audit-actions", () => ({
  loadMoreAuditAction: vi.fn(),
  verifyAuditChainAction: vi.fn(),
  loadMoreAuthAuditAction: vi.fn(),
  verifyAuthAuditChainAction: vi.fn(),
}));

import AuditPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  requireOrgAccess.mockResolvedValue({
    userId: "u_1",
    orgId: "org_1",
    slug: "acme",
    role: "owner",
  });
  loadAudit.mockResolvedValue({ status: "ok", items: [], nextSeq: null });
  loadAuthAudit.mockResolvedValue({ status: "ok", items: [], nextSeq: null });
});

describe("AuditPage — the role gate", () => {
  // This page gate is the ONLY barrier before the initial (SSR) chain read: loadAudit takes an orgId and
  // does no role check of its own. The mint ceiling already refuses a member an `audit:read` key, so if this
  // gate were missing the ceiling would be decorative — the member would read the chain here instead.
  it("REFUSES a plain member — and never reads the chain", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "u_m",
      orgId: "org_1",
      slug: "acme",
      role: "member",
    });
    render(await AuditPage({ params: Promise.resolve({ slug: "acme" }) }));

    expect(screen.getByText(/only owners and admins can read the audit log/i)).toBeInTheDocument();
    expect(loadAudit).not.toHaveBeenCalled(); // NEITHER chain was touched
    expect(loadAuthAudit).not.toHaveBeenCalled();
  });

  it("reads the chain for an owner", async () => {
    render(await AuditPage({ params: Promise.resolve({ slug: "acme" }) }));
    expect(loadAudit).toHaveBeenCalledWith("org_1");
  });

  it("reads the chain for an admin", async () => {
    requireOrgAccess.mockResolvedValueOnce({
      userId: "u_a",
      orgId: "org_1",
      slug: "acme",
      role: "admin",
    });
    render(await AuditPage({ params: Promise.resolve({ slug: "acme" }) }));
    expect(loadAudit).toHaveBeenCalledWith("org_1");
  });
});
