import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OrgSwitcher } from "./org-switcher";

const ORGS = [
  { orgId: "org_a", name: "Personal", role: "owner" },
  { orgId: "org_b", name: "Acme Team", role: "member" },
];

describe("OrgSwitcher", () => {
  it("renders NOTHING when the user has only one org — a one-option picker is just noise", () => {
    const { container } = render(
      <OrgSwitcher orgs={[ORGS[0]!]} currentOrgId="org_a" switchOrg={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the current org as selected, and the others as options", () => {
    render(<OrgSwitcher orgs={ORGS} currentOrgId="org_b" switchOrg={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveValue("org_b");
    expect(screen.getByRole("option", { name: "Personal" })).toBeInTheDocument();
  });

  it("submits the picked org to the server action", async () => {
    const user = userEvent.setup();
    const switchOrg = vi.fn(async () => {});
    render(<OrgSwitcher orgs={ORGS} currentOrgId="org_a" switchOrg={switchOrg} />);

    await user.selectOptions(screen.getByRole("combobox"), "org_b");

    await waitFor(() => expect(switchOrg).toHaveBeenCalledTimes(1));
    const fd = switchOrg.mock.calls[0][0] as FormData;
    expect(fd.get("orgId")).toBe("org_b");
  });
});
