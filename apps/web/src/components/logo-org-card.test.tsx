import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
// Keep the cropper + avatar inert — this test is about the card's role-gated controls, not the crop flow.
vi.mock("./avatar-cropper", () => ({ AvatarCropperDialog: () => null }));
vi.mock("./org-avatar", () => ({ OrgAvatar: () => <div data-testid="org-avatar" /> }));

import { LogoOrgCard } from "./logo-org-card";

afterEach(cleanup);

describe("LogoOrgCard", () => {
  it("hides every manage control from a plain member (parity with rename-org-card)", () => {
    render(<LogoOrgCard slug="acme" name="Acme" hasLogo canManage={false} />);
    expect(screen.queryByRole("button", { name: /logo|change|upload|remove/i })).toBeNull();
    expect(screen.getByTestId("org-avatar")).toBeInTheDocument(); // still shows the logo/tile, read-only
  });

  it("offers Change + Remove to an owner/admin when a logo already exists", () => {
    render(<LogoOrgCard slug="acme" name="Acme" hasLogo canManage />);
    expect(screen.getByRole("button", { name: /change logo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });

  it("offers Upload (not Remove) to an owner/admin when there's no logo yet", () => {
    render(<LogoOrgCard slug="acme" name="Acme" hasLogo={false} canManage />);
    expect(screen.getByRole("button", { name: /upload logo/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });
});
