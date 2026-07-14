import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "acme" }) }));

import { OrgSwitcher } from "./org-switcher";

const ORGS = [
  { orgId: "org_a", slug: "dana", name: "Personal" },
  { orgId: "org_b", slug: "acme", name: "Acme Team" },
];

const renderSwitcher = (orgs: typeof ORGS, currentOrgId: string) => {
  const current = orgs.find((o) => o.orgId === currentOrgId) ?? orgs[0]!;
  return render(
    <OrgSwitcher
      orgs={orgs}
      currentOrgId={currentOrgId}
      currentName={current.name}
      currentSlug={current.slug}
    />,
  );
};

const open = async () => {
  await userEvent.click(screen.getByRole("button", { name: /switch organization/i }));
};

beforeEach(() => vi.clearAllMocks());

describe("OrgSwitcher", () => {
  // It used to HIDE ITSELF below two orgs, reasoning that a one-option picker is noise. That had it backwards:
  // most users have exactly one org, so for the overwhelming majority the control naming which org they were
  // acting in was invisible. Showing the current org is not noise — it is the label on the workspace.
  it("names the current org even when it is the only one", () => {
    renderSwitcher([ORGS[0]!], "org_a");

    expect(screen.getByRole("button", { name: /organization: personal/i })).toBeInTheDocument();
  });

  it("always offers Create organization, single-org user included", async () => {
    renderSwitcher([ORGS[0]!], "org_a");
    await open();

    expect(screen.getByRole("menuitem", { name: /create organization/i })).toHaveAttribute(
      "href",
      "/org/new",
    );
  });

  it("lists every org, and marks the current one", async () => {
    renderSwitcher(ORGS, "org_b");
    await open();

    expect(screen.getByRole("menuitem", { name: /personal/i })).toBeInTheDocument();
    const current = screen.getByRole("menuitem", { name: /acme team/i });
    // Marked for assistive tech, not merely ticked with a glyph — otherwise a screen-reader user hears an
    // identical list with nothing saying where they already are.
    expect(current).toHaveAttribute("aria-current", "true");
  });

  // Switching used to submit a server action that re-minted the session cookie onto the new org. With one
  // cookie per browser that silently retargeted every OTHER open tab's writes (ADR-0117). The org is in the
  // URL now, so switching is just going somewhere else: a LINK, no mutation, no cross-tab bleed. This test is
  // what stops it quietly becoming a mutation again.
  it("switches by NAVIGATING — each org is a plain link, not an action", async () => {
    renderSwitcher(ORGS, "org_a");
    await open();

    // The org's OVERVIEW, not the equivalent deep path: the current page may name a resource that does not
    // exist over there, and a switcher that 404s you is worse than one that takes a beat.
    expect(screen.getByRole("menuitem", { name: /acme team/i })).toHaveAttribute(
      "href",
      "/org/acme/dashboard",
    );
  });

  // `loadMyOrgs` degrades to an empty list if its read blips — the shell must never fail to render because the
  // picker's query hiccuped. But the one label that must always be right is the org you are LOOKING AT, and the
  // gate already knows it. Deriving the trigger from the list would blank it out exactly when things go wrong.
  it("still names the current org when the directory read comes back empty", () => {
    render(
      <OrgSwitcher orgs={[]} currentOrgId="org_b" currentName="Acme Team" currentSlug="acme" />,
    );

    expect(screen.getByRole("button", { name: /organization: acme team/i })).toBeInTheDocument();
  });
});
