import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

function fixture() {
  return (
    <Tabs defaultValue="active">
      <TabsList aria-label="Credential status">
        <TabsTrigger value="active">Active</TabsTrigger>
        <TabsTrigger value="revoked">Revoked</TabsTrigger>
      </TabsList>
      <TabsContent value="active">active panel</TabsContent>
      <TabsContent value="revoked">revoked panel</TabsContent>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("shows the default tab's panel and hides the others", () => {
    render(fixture());
    expect(screen.getByText("active panel")).toBeVisible();
    // Radix unmounts inactive panels — the hidden one is absent, not just visually hidden.
    expect(screen.queryByText("revoked panel")).not.toBeInTheDocument();
  });

  it("switches panels when another tab is selected", async () => {
    const user = userEvent.setup();
    render(fixture());
    await user.click(screen.getByRole("tab", { name: "Revoked" }));
    expect(screen.getByText("revoked panel")).toBeVisible();
    expect(screen.queryByText("active panel")).not.toBeInTheDocument();
  });

  it("exposes accessible tablist/tab semantics", () => {
    render(fixture());
    expect(screen.getByRole("tablist", { name: "Credential status" })).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    // The active trigger is marked selected for assistive tech.
    expect(screen.getByRole("tab", { name: "Active" })).toHaveAttribute("aria-selected", "true");
  });
});
