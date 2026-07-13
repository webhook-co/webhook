import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  useRouter: () => ({ push }),
}));

import { OrgSwitcher } from "./org-switcher";

const ORGS = [
  { orgId: "org_a", slug: "dana", name: "Personal", role: "owner" },
  { orgId: "org_b", slug: "acme", name: "Acme Team", role: "member" },
];

beforeEach(() => vi.clearAllMocks());

describe("OrgSwitcher", () => {
  it("renders NOTHING when the user has only one org — a one-option picker is just noise", () => {
    const { container } = render(<OrgSwitcher orgs={[ORGS[0]!]} currentOrgId="org_a" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current org as selected, and the others as options", () => {
    render(<OrgSwitcher orgs={ORGS} currentOrgId="org_b" />);
    expect(screen.getByRole("combobox")).toHaveValue("org_b");
    expect(screen.getByRole("option", { name: "Personal" })).toBeInTheDocument();
  });

  it("NAVIGATES to the picked org — it no longer mutates the session", async () => {
    // Switching used to submit a server action that re-minted the session cookie onto the new org. With one
    // cookie per browser that silently retargeted every OTHER open tab's writes. The org is in the URL now,
    // so switching is just going somewhere else: no mutation, no cross-tab bleed.
    const user = userEvent.setup();
    render(<OrgSwitcher orgs={ORGS} currentOrgId="org_a" />);

    await user.selectOptions(screen.getByRole("combobox"), "org_b");

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    // The org's OVERVIEW, not the equivalent deep path: the current page may name a resource that simply does
    // not exist over there, and a switcher that 404s you is worse than one that takes a beat.
    expect(push).toHaveBeenCalledWith("/org/acme/dashboard");
  });
});
