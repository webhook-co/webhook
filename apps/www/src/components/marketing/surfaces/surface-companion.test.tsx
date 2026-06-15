import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SEED_ROWS } from "@/components/marketing/inspector/stream-data";
import { SurfaceCompanion } from "./surface-companion";

const VERIFIED = SEED_ROWS[0]!; // github / push / verified
const FAILED = SEED_ROWS[2]!; // shopify / orders.create / failed

describe("SurfaceCompanion", () => {
  it("renders all four surfaces at once in the parity group", () => {
    render(<SurfaceCompanion row={VERIFIED} />);
    const group = screen.getByRole("group", { name: /across all four surfaces/i });
    for (const title of ["mcp.webhook.co", "wbhk — zsh", "api.webhook.co", "webhook.co/events"]) {
      expect(within(group).getByText(title)).toBeInTheDocument();
    }
  });

  it("offers a keyboard-accessible Tabs fallback with MCP selected by default", () => {
    render(<SurfaceCompanion row={VERIFIED} />);
    expect(screen.getByRole("tablist", { name: /by surface/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "MCP" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "CLI" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("tab", { name: "Web app" })).toBeInTheDocument();
  });

  it("renders the row's own event, and reflects a failed signature across surfaces", () => {
    render(<SurfaceCompanion row={FAILED} />);
    const group = screen.getByRole("group", { name: /across all four surfaces/i });
    expect(within(group).getAllByText(/shopify/).length).toBeGreaterThan(0);
    expect(within(group).getAllByText(/timestamp too old/).length).toBeGreaterThan(0);
  });
});
