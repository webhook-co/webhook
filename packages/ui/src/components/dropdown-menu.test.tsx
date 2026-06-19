import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu";

function Example({ onRevoke = () => {} }: { onRevoke?: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>Actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>evt_1Qx84K</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRevoke}>Revoke</DropdownMenuItem>
        <DropdownMenuItem>Copy id</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("DropdownMenu", () => {
  it("is closed until the trigger is activated", () => {
    render(<Example />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the menu when the trigger is clicked", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("calls a menu item's onSelect and closes when the item is clicked", async () => {
    const onRevoke = vi.fn();
    render(<Example onRevoke={onRevoke} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Revoke" }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("supports keyboard selection (arrow down then enter)", async () => {
    const onRevoke = vi.fn();
    render(<Example onRevoke={onRevoke} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  it("renders a non-interactive label and a separator", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByText("evt_1Qx84K")).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("styles a destructive item with the danger token", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem destructive>Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveClass("text-danger");
  });
});
