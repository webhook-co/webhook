import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ScopeSummary } from "./scope-summary";

afterEach(cleanup);

describe("ScopeSummary", () => {
  it("collapses many scopes into a single count summary, not a wall of chips", () => {
    render(<ScopeSummary scopes={["events:read", "events:replay", "endpoints:write"]} />);
    // The compact face is a count — the whole point of the slimming.
    expect(screen.getByText(/3 permissions/i)).toBeInTheDocument();
  });

  it("singularizes the count for a lone scope", () => {
    render(<ScopeSummary scopes={["events:read"]} />);
    expect(screen.getByText(/1 permission\b/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 permissions/i)).toBeNull();
  });

  it("reveals a human title + description per scope inside the disclosure (not the raw scope alone)", () => {
    render(<ScopeSummary scopes={["events:read"]} />);
    // The expandable body carries the catalog copy — plain English, always present in the DOM (native
    // <details>, so it's there for assertion and for keyboard/AT users even before opening).
    expect(screen.getByText("View events")).toBeInTheDocument();
    expect(screen.getByText(/captured webhook events/i)).toBeInTheDocument();
  });

  it("still shows an unknown scope by its raw name rather than hiding it", () => {
    render(<ScopeSummary scopes={["future:thing"]} />);
    expect(screen.getByText("future:thing")).toBeInTheDocument();
  });

  it("renders a quiet empty state for no scopes (no empty disclosure)", () => {
    render(<ScopeSummary scopes={[]} />);
    expect(screen.getByText(/no permissions/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 permissions/i)).toBeNull();
  });
});
