import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { axeComponent } from "@/test/axe";

import { Tabs, type TabItem } from "./tabs";

const ITEMS: TabItem[] = [
  { id: "mcp", label: "MCP", panel: <p>mcp panel</p> },
  { id: "cli", label: "CLI", panel: <p>cli panel</p> },
  { id: "api", label: "API", panel: <p>api panel</p> },
  { id: "web", label: "Web", panel: <p>web panel</p> },
];

function setup() {
  return render(<Tabs items={ITEMS} idBase="t" defaultId="mcp" aria-label="Surfaces" />);
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("Tabs", () => {
  it("selects the default tab with roving tabindex and shows only its panel", () => {
    setup();
    expect(tab("MCP")).toHaveAttribute("aria-selected", "true");
    expect(tab("MCP")).toHaveAttribute("tabindex", "0");
    expect(tab("CLI")).toHaveAttribute("aria-selected", "false");
    expect(tab("CLI")).toHaveAttribute("tabindex", "-1");

    const panel = screen.getByRole("tabpanel", { name: "MCP" });
    expect(panel).toBeVisible();
    expect(panel).toHaveAttribute("aria-labelledby", "t-mcp");
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(screen.getByText("cli panel").closest("[role=tabpanel]")).toHaveAttribute("hidden");
  });

  it("activates a tab on click", async () => {
    setup();
    await userEvent.click(tab("CLI"));
    expect(tab("CLI")).toHaveAttribute("aria-selected", "true");
    expect(tab("MCP")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tabpanel", { name: "CLI" })).toBeVisible();
  });

  it("moves selection and focus with arrow keys, wrapping at both ends", async () => {
    setup();
    tab("MCP").focus();
    await userEvent.keyboard("{ArrowLeft}"); // wrap to the last tab
    expect(tab("Web")).toHaveAttribute("aria-selected", "true");
    expect(tab("Web")).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}"); // wrap back to the first
    expect(tab("MCP")).toHaveAttribute("aria-selected", "true");
    expect(tab("MCP")).toHaveFocus();
  });

  it("jumps to first/last with Home and End", async () => {
    setup();
    tab("MCP").focus();
    await userEvent.keyboard("{End}");
    expect(tab("Web")).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Home}");
    expect(tab("MCP")).toHaveAttribute("aria-selected", "true");
  });

  it("has no axe violations (default, and after selecting another tab)", async () => {
    const { container } = setup();
    expect(await axeComponent(container)).toHaveNoViolations();
    await userEvent.click(tab("CLI"));
    expect(await axeComponent(container)).toHaveNoViolations();
  });
});
