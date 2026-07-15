import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScopeSummary } from "./scope-summary";

const describe_ = (scope: string) => {
  const map: Record<string, { title: string; description: string }> = {
    "events:read": { title: "View events", description: "Read captured webhook events." },
    "events:delete": { title: "Delete events", description: "Permanently purge captured events." },
  };
  const hit = map[scope];
  return hit ? { scope, ...hit } : { scope, title: scope, description: scope };
};

describe("ScopeSummary", () => {
  it("is COLLAPSED by default but keeps every scope in the DOM (accessible while collapsed)", () => {
    const { container } = render(
      <ScopeSummary scopes={["events:read", "events:delete"]} describe={describe_} />,
    );
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false); // closed by default (the founder's ask)
    // …yet the titles, exact machine scopes, AND the plain-English descriptions are all present in the DOM
    // even collapsed (screen readers reach the full grant; the "never leave a permission unexplained"
    // invariant the scope catalog exists to enforce).
    expect(screen.getByText("View events")).toBeTruthy();
    expect(screen.getByText("events:read")).toBeTruthy();
    expect(screen.getByText(/Read captured webhook events\./)).toBeTruthy();
    expect(screen.getByText("Delete events")).toBeTruthy();
    expect(screen.getByText("events:delete")).toBeTruthy();
    expect(screen.getByText(/Permanently purge captured events\./)).toBeTruthy();
  });

  it("SINGULARizes the count for one scope (exactly '1 permission', never '1 permissions')", () => {
    render(<ScopeSummary scopes={["events:read"]} describe={describe_} />);
    expect(screen.getByText("1 permission")).toBeTruthy();
    expect(screen.queryByText(/1 permissions/)).toBeNull(); // guards the singular/plural ternary
  });

  it("owns the count and appends a caller labelSuffix (pluralization not duplicated at call sites)", () => {
    render(
      <ScopeSummary
        scopes={["events:read", "events:delete"]}
        describe={describe_}
        labelSuffix=" — review before authorizing"
      />,
    );
    expect(screen.getByText("2 permissions — review before authorizing")).toBeTruthy();
  });

  it("suppresses the separate machine-scope chip for an UNKNOWN scope (title === scope fallback)", () => {
    const { container } = render(
      <ScopeSummary scopes={["future:capability"]} describe={describe_} />,
    );
    // For an uncatalogued scope, describe falls back to title===scope. The `title !== scope` guard must then
    // drop the mono machine-scope chip (which would just repeat the title) — exercising that branch.
    const li = container.querySelector("li");
    expect(li?.textContent).toContain("future:capability"); // still shown (as the title)
    expect(li?.querySelector(".font-mono")).toBeNull(); // …but no duplicate mono chip
  });

  it("renders a friendly empty state for no scopes (no '0 permissions' count)", () => {
    render(<ScopeSummary scopes={[]} describe={describe_} />);
    expect(screen.getByText(/no permissions/i)).toBeTruthy();
    expect(screen.queryByText(/0 permission/)).toBeNull();
  });
});
