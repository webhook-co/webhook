import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppShellClient } from "./app-shell-client";

describe("AppShellClient (responsive nav)", () => {
  function renderShell() {
    return render(
      <AppShellClient
        homeHref="/"
        sidebar={<a href="/endpoints">Endpoints</a>}
        topBar={<span>top bar</span>}
      >
        <p>page content</p>
      </AppShellClient>,
    );
  }

  it("exposes a hamburger that opens the focus-trapped nav drawer (below md)", () => {
    renderShell();

    const burger = screen.getByRole("button", { name: "Open navigation" });
    expect(burger).toBeInTheDocument();
    // Drawer closed initially — no dialog, no close control.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close navigation" })).toBeNull();

    fireEvent.click(burger);

    // Drawer open: the dialog appears with the nav inside and a close control.
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Endpoints" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close navigation" })).toBeInTheDocument();
  });

  it("closes the drawer from its close button", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
