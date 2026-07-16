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
  it("renders the suspension screen for a free-org-cap suspended org", async () => {
    requireOrgAccess.mockResolvedValue(access({}));
    render(await SuspendedPage({ params }));

    expect(screen.getByRole("heading", { name: /suspended/i })).toBeInTheDocument();
    // free_org_cap copy names the limit and offers the upgrade path.
    expect(screen.getByText(/organization limit/i)).toBeInTheDocument();
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

  it("tells the truth about suspension — no 'read-only', no preserved-events promise, no deadline", async () => {
    // This screen is where the cap emails' CTA lands, so it must agree with them. Three claims it used to
    // make and must never make again:
    //  - "read-only": requireActiveOrgAccess REDIRECTS every data page here; the data is unreachable, not
    //    frozen-but-browsable, so "read-only" sends the owner hunting for events they cannot open.
    //  - "nothing has been deleted" / "events are preserved": retention.ts prunes on received_at with no
    //    orgs.status predicate, so a suspended free org's history ages away while this reassures them.
    //  - a restore deadline: orgs.restore_deadline is written and read by nothing — restoration never expires.
    requireOrgAccess.mockResolvedValue(access({}));
    const { container } = render(await SuspendedPage({ params }));
    const copy = container.textContent ?? "";

    expect(copy).not.toMatch(/read-only/i);
    expect(copy).not.toMatch(/nothing has been deleted/i);
    expect(copy).not.toMatch(/events.{0,30}(are preserved|preserved)/i);
    expect(copy).not.toMatch(/stays exactly as you left it/i);
    expect(copy).not.toMatch(/deadline|you have until|restore by/i);
    // What it says instead — matching the suspended email verbatim in substance.
    expect(copy).toMatch(/isn't reachable while it's suspended/i);
    expect(copy).toMatch(/keep aging out on the free plan's usual retention/i);
    expect(copy).toMatch(/the sooner you restore it, the more history you keep/i);
  });

  it("keeps the free-cap-specific facts OUT of the generic reason branch", async () => {
    // Retention and the no-deadline fact are true only for free_org_cap. restore_deadline is reserved by 0083
    // for a future hard-delete slice, and retention is plan-specific — so the first non-cap reason to ship (a
    // paid org suspended for non-payment, exactly what restore_deadline was designed for) must not inherit
    // free-plan claims that are false for it.
    requireOrgAccess.mockResolvedValue(access({ suspendedReason: "some_future_reason" }));
    const { container } = render(await SuspendedPage({ params }));
    const copy = container.textContent ?? "";

    expect(copy).not.toMatch(/free plan|retention|aging out|deadline/i);
    expect(copy).toMatch(/endpoints, destinations, settings, and team are all kept/i);
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
