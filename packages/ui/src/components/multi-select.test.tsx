import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { MultiSelect, type MultiSelectOption } from "./multi-select";

const OPTIONS: MultiSelectOption[] = [
  { value: "stripe", label: "stripe" },
  { value: "github", label: "github" },
  { value: "shopify", label: "shopify" },
];

function Harness({ initial = [] as string[] }: { initial?: string[] }) {
  const [selected, setSelected] = React.useState<string[]>(initial);
  return (
    <MultiSelect
      options={OPTIONS}
      selected={selected}
      onChange={setSelected}
      placeholder="All providers"
      label="Filter by provider"
      searchable
    />
  );
}

describe("MultiSelect", () => {
  it("summarizes the selection on the trigger (placeholder → label → count)", async () => {
    render(<Harness />);
    const trigger = () => screen.getByRole("button", { name: /Filter by provider/ });
    expect(trigger()).toHaveTextContent("All providers");

    await userEvent.click(trigger());
    await userEvent.click(screen.getByRole("option", { name: "stripe" }));
    expect(trigger()).toHaveTextContent("stripe");

    await userEvent.click(screen.getByRole("option", { name: "github" }));
    expect(trigger()).toHaveTextContent("2 selected");
  });

  it("toggles selection and preserves option order in onChange", async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={["github"]}
        onChange={onChange}
        placeholder="All providers"
        label="Filter by provider"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter by provider/ }));
    // Select stripe (declared before github) → onChange keeps declaration order.
    await userEvent.click(screen.getByRole("option", { name: "stripe" }));
    expect(onChange).toHaveBeenCalledWith(["stripe", "github"]);
  });

  it("deselects an already-selected option", async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={["stripe"]}
        onChange={onChange}
        placeholder="All providers"
        label="Filter by provider"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter by provider/ }));
    await userEvent.click(screen.getByRole("option", { name: "stripe" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("filters options by the search box and shows a no-match message", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: /Filter by provider/ }));
    const search = screen.getByLabelText("Search…");
    await userEvent.type(search, "git");
    expect(screen.getByRole("option", { name: "github" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "stripe" })).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, "zzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("hides the search box when not searchable", async () => {
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[]}
        onChange={() => {}}
        placeholder="All statuses"
        label="Filter by status"
        searchable={false}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter by status/ }));
    expect(screen.queryByLabelText("Search…")).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("renders an option's `icon` in the list rows and in the single-selection summary", async () => {
    const withIcons: MultiSelectOption[] = [
      { value: "stripe", label: "Stripe", icon: <svg data-testid="logo-stripe" /> },
      { value: "github", label: "GitHub", icon: <svg data-testid="logo-github" /> },
    ];
    function Harnessed() {
      const [selected, setSelected] = React.useState<string[]>([]);
      return (
        <MultiSelect
          options={withIcons}
          selected={selected}
          onChange={setSelected}
          placeholder="All providers"
          label="Filter by provider"
        />
      );
    }
    render(<Harnessed />);
    const trigger = () => screen.getByRole("button", { name: /Filter by provider/ });

    // Each option row renders its icon.
    await userEvent.click(trigger());
    expect(screen.getByTestId("logo-stripe")).toBeInTheDocument();
    expect(screen.getByTestId("logo-github")).toBeInTheDocument();

    // A single selection surfaces its icon in the trigger summary (alongside the label).
    await userEvent.click(screen.getByRole("option", { name: "Stripe" }));
    expect(trigger()).toHaveTextContent("Stripe");
    expect(within(trigger()).getByTestId("logo-stripe")).toBeInTheDocument();
  });

  it("is keyboard-operable: Arrow to highlight, Enter to toggle, and stays open (multi)", async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        options={OPTIONS}
        selected={[]}
        onChange={onChange}
        placeholder="All providers"
        label="Filter by provider"
        searchable
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter by provider/ }));
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-multiselectable", "true");
    screen.getByLabelText("Search…").focus();
    await userEvent.keyboard("{ArrowDown}{Enter}"); // stripe(0) → github(1) → toggle on
    expect(onChange).toHaveBeenCalledWith(["github"]);
    // A multi-select toggle keeps the popover open to pick more.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("keeps aria-activedescendant a valid IDREF even when an option value contains spaces", async () => {
    // A generic reusable control may get values with spaces (e.g. a country). The option DOM id must stay a
    // valid, resolvable IDREF — a value-derived id would embed the space and silently break the reference.
    const opts: MultiSelectOption[] = [
      { value: "united states", label: "United States" },
      { value: "canada", label: "Canada" },
    ];
    render(
      <MultiSelect
        options={opts}
        selected={[]}
        onChange={() => {}}
        placeholder="All regions"
        label="Filter by region"
        searchable
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter by region/ }));
    const search = screen.getByLabelText("Search…");
    search.focus();
    await userEvent.keyboard("{ArrowDown}"); // highlight an option → sets aria-activedescendant
    const activeId = search.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    expect(activeId).not.toMatch(/\s/); // a valid HTML id has no whitespace
    expect(document.getElementById(activeId!)).not.toBeNull(); // and it resolves to a real option
  });

  it("matches an option's value/keywords in search, not only the label", async () => {
    const opts: MultiSelectOption[] = [
      { value: "ms_graph", label: "Microsoft Graph" },
      { value: "meta", label: "Meta", keywords: ["facebook"] },
    ];
    render(
      <MultiSelect
        options={opts}
        selected={[]}
        onChange={() => {}}
        placeholder="All providers"
        label="Filter by provider"
        searchable
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Filter by provider/ }));
    const search = screen.getByLabelText("Search…");
    await userEvent.type(search, "facebook"); // keyword hit on Meta
    expect(screen.getByRole("option", { name: "Meta" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Microsoft Graph" })).not.toBeInTheDocument();
    await userEvent.clear(search);
    await userEvent.type(search, "ms_graph"); // value/slug hit
    expect(screen.getByRole("option", { name: "Microsoft Graph" })).toBeInTheDocument();
  });
});
