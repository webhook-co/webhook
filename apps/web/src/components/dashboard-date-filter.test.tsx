import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let currentParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => currentParams,
}));

import { DashboardDateFilter } from "./dashboard-date-filter";

describe("DashboardDateFilter", () => {
  it("reflects the active window from the URL query on its trigger", () => {
    currentParams = new URLSearchParams("range=7d");
    render(<DashboardDateFilter />);
    // The picker's trigger shows the active window label — proving URL → value wiring.
    expect(screen.getByRole("button", { name: /last 7 days/i })).toBeInTheDocument();
  });

  it("shows the default (all time / any) trigger when no window is set", () => {
    currentParams = new URLSearchParams();
    render(<DashboardDateFilter />);
    // No range/from/to → the picker renders its inactive trigger, labelled for the DELIVERY-outcomes
    // context (not the events list's "received date").
    expect(screen.getByRole("button", { name: /filter by delivery date/i })).toBeInTheDocument();
  });
});
