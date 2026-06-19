import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AccountMenu } from "./account-menu";

describe("AccountMenu", () => {
  it("renders initials on the trigger", () => {
    render(<AccountMenu name="Dana Kessler" email="dana@acme.co" onLogout={() => {}} />);
    expect(screen.getByRole("button", { name: "Account menu" })).toHaveTextContent("DK");
  });

  it("shows the signed-in identity and a logout option when opened", async () => {
    render(<AccountMenu name="Dana Kessler" email="dana@acme.co" onLogout={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByText("Dana Kessler")).toBeInTheDocument();
    expect(screen.getByText("dana@acme.co")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });

  it("invokes onLogout when Log out is selected", async () => {
    const onLogout = vi.fn();
    render(<AccountMenu name="Dana Kessler" email="dana@acme.co" onLogout={onLogout} />);
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
