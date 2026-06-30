import { render, screen } from "@testing-library/react";
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
});
