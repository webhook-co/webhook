import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "./popover";

function Example() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button>Filters</Button>
      </PopoverTrigger>
      <PopoverContent>
        {/* Arbitrary interactive content — the reason this isn't a DropdownMenu. */}
        <Input aria-label="search" placeholder="Search" />
        <PopoverClose>Done</PopoverClose>
      </PopoverContent>
    </Popover>
  );
}

describe("Popover", () => {
  it("is closed until the trigger is activated", () => {
    render(<Example />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on trigger click and renders arbitrary interactive content", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("search")).toBeInTheDocument();
  });

  it("does NOT impose menu semantics — typing into an input is not hijacked", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    const input = screen.getByLabelText("search");
    await userEvent.type(input, "stripe");
    expect(input).toHaveValue("stripe");
  });

  it("closes on Escape and via PopoverClose", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
    await userEvent.click(screen.getByText("Done"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
