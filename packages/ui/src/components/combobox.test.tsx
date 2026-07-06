import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { Combobox, type ComboboxOption } from "./combobox";

const OPTIONS: ComboboxOption[] = [
  { value: "stripe", label: "Stripe", icon: <svg data-testid="logo-stripe" /> },
  { value: "github", label: "GitHub", icon: <svg data-testid="logo-github" /> },
  { value: "shopify", label: "Shopify" },
];

/** A small controlled harness so selecting an option updates the trigger, like a real form field. */
function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = React.useState("stripe");
  return (
    <Combobox
      label="Provider"
      options={OPTIONS}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      searchable
      searchPlaceholder="Search providers…"
    />
  );
}

describe("Combobox (single-select searchable dropdown)", () => {
  it("shows the selected option's label (and icon) in the trigger", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /provider: stripe/i });
    expect(trigger).toBeInTheDocument();
    expect(screen.getByTestId("logo-stripe")).toBeInTheDocument();
  });

  it("opens on click and lists every option by label (never the raw value)", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /provider:/i }));
    expect(screen.getByRole("option", { name: "Stripe" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Shopify" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "stripe" })).not.toBeInTheDocument();
  });

  it("marks the current value as selected", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /provider:/i }));
    expect(screen.getByRole("option", { name: "Stripe" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "GitHub" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("filters options by the search query", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /provider:/i }));
    await user.type(screen.getByLabelText("Search providers…"), "git");
    expect(screen.getByRole("option", { name: "GitHub" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Stripe" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Shopify" })).not.toBeInTheDocument();
  });

  it("shows a 'no matches' message when the query matches nothing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: /provider:/i }));
    await user.type(screen.getByLabelText("Search providers…"), "zzz");
    expect(screen.getByText(/no matches/i)).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(
      <Combobox label="Provider" options={OPTIONS} value="stripe" onChange={vi.fn()} disabled />,
    );
    const trigger = screen.getByRole("button", { name: /provider: stripe/i });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("selects an option (single value), fires onChange, and closes the popover", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /provider:/i }));
    await user.click(screen.getByRole("option", { name: "GitHub" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("github");
    // Closed: the option list is gone and the trigger now summarizes the new selection.
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /provider: github/i })).toBeInTheDocument();
  });

  it("is keyboard-operable: Arrow to highlight, Enter to select", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /provider:/i }));
    const search = screen.getByLabelText("Search providers…");
    search.focus();
    await user.keyboard("{ArrowDown}{Enter}"); // Stripe(0) → GitHub(1) → select
    expect(onChange).toHaveBeenCalledExactlyOnceWith("github");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("re-selecting the current value closes without firing onChange (parity with <select>)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Combobox label="Provider" options={OPTIONS} value="stripe" onChange={onChange} searchable />,
    );
    await user.click(screen.getByRole("button", { name: /provider: stripe/i }));
    await user.click(screen.getByRole("option", { name: "Stripe" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("searches the value/slug and keywords, not just the label", async () => {
    const user = userEvent.setup();
    const opts: ComboboxOption[] = [
      { value: "ms_graph", label: "Microsoft Graph" },
      { value: "meta", label: "Meta", keywords: ["facebook"] },
    ];
    render(
      <Combobox label="Provider" options={opts} value="ms_graph" onChange={vi.fn()} searchable />,
    );
    await user.click(screen.getByRole("button", { name: /provider:/i }));
    const search = screen.getByLabelText("Search…");
    // A brand alias (keyword) matches even though the label doesn't contain it.
    await user.type(search, "facebook");
    expect(screen.getByRole("option", { name: "Meta" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Microsoft Graph" })).not.toBeInTheDocument();
    // The technical slug matches even though the label doesn't contain it.
    await user.clear(search);
    await user.type(search, "ms_graph");
    expect(screen.getByRole("option", { name: "Microsoft Graph" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Meta" })).not.toBeInTheDocument();
  });
});
