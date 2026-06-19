import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "./table";

function Example() {
  return (
    <Table>
      <TableCaption>Recent deliveries</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Event</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>evt_1</TableCell>
          <TableCell>delivered</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>evt_2</TableCell>
          <TableCell>failed</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe("Table", () => {
  it("renders a table", () => {
    render(<Example />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders the column headers in order", () => {
    render(<Example />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Event",
      "Status",
    ]);
  });

  it("renders body rows and cells", () => {
    render(<Example />);
    expect(screen.getByRole("cell", { name: "evt_1" })).toBeInTheDocument();
    // one header row + two body rows
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });

  it("renders a caption", () => {
    render(<Example />);
    expect(screen.getByText("Recent deliveries")).toBeInTheDocument();
  });

  it("renders an empty state spanning the columns", () => {
    render(
      <Table>
        <TableBody>
          <TableEmpty colSpan={2}>No events yet.</TableEmpty>
        </TableBody>
      </Table>,
    );
    const cell = screen.getByRole("cell", { name: "No events yet." });
    expect(cell).toHaveAttribute("colspan", "2");
  });

  it("merges a custom className onto the table", () => {
    render(<Table className="custom-table" data-testid="t" />);
    expect(screen.getByTestId("t")).toHaveClass("custom-table");
  });

  it("forwards a ref to the table element", () => {
    const ref = createRef<HTMLTableElement>();
    render(<Table ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTableElement);
  });

  it("forwards a ref to a cell element", () => {
    const ref = createRef<HTMLTableCellElement>();
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell ref={ref}>evt_1</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(ref.current).toBeInstanceOf(HTMLTableCellElement);
  });

  it("makes the scroll wrapper keyboard-focusable and forwards containerProps", () => {
    render(<Table containerProps={{ role: "region", "aria-label": "Deliveries" }} />);
    const region = screen.getByRole("region", { name: "Deliveries" });
    expect(region).toHaveAttribute("tabindex", "0");
    // the table lives inside the scroll region
    expect(region).toContainElement(screen.getByRole("table"));
  });
});
