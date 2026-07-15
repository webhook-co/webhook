import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAccess = vi.fn();
vi.mock("@/server/org-access", () => ({
  requireOrgAccess: (...a: unknown[]) => requireOrgAccess(...a),
}));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

import SuspendedPage from "./page";

const access = (over: Record<string, unknown>) => ({
  userId: "usr_1",
  orgId: "org_1",
  slug: "acme",
  name: "Acme",
  role: "owner",
  user: { name: "Dana", email: "dana@acme.co", image: null },
  status: "suspended",
  suspendedReason: "free_org_cap",
  ...over,
});

const params = Promise.resolve({ slug: "acme" });

beforeEach(() => vi.clearAllMocks());

describe("SuspendedPage", () => {
  it("renders the read-only suspension screen for a free-org-cap suspended org", async () => {
    requireOrgAccess.mockResolvedValue(access({}));
    render(await SuspendedPage({ params }));

    expect(screen.getByRole("heading", { name: /suspended/i })).toBeInTheDocument();
    // free_org_cap copy names the free-organization limit and offers the upgrade path.
    expect(screen.getByText(/free-organization limit/i)).toBeInTheDocument();
    // The way out: billing (upgrade) + settings both link to the canonical org URL.
    expect(screen.getByRole("link", { name: /upgrade to restore/i })).toHaveAttribute(
      "href",
      "/org/acme/billing",
    );
    expect(screen.getByRole("link", { name: /organization settings/i })).toHaveAttribute(
      "href",
      "/org/acme/settings",
    );
  });

  it("falls back to generic copy for an unknown suspension reason (never dead-ends)", async () => {
    requireOrgAccess.mockResolvedValue(access({ suspendedReason: "some_future_reason" }));
    render(await SuspendedPage({ params }));

    expect(screen.getByRole("heading", { name: /suspended/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to billing/i })).toBeInTheDocument();
  });

  it("redirects an ACTIVE org to its dashboard — a stale bookmark or just-restored org sees no false alarm", async () => {
    requireOrgAccess.mockResolvedValue(access({ status: "active", suspendedReason: null }));
    await expect(SuspendedPage({ params })).rejects.toThrow("NEXT_REDIRECT:/org/acme/dashboard");
  });
});
