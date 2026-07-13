import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DashboardData } from "@/server/dashboard";

vi.mock("@/server/org-access", () => ({
  requireOrgAccess: vi.fn(async () => ({
    userId: "usr_1",
    orgId: "org_1",
    slug: "acme",
    role: "owner",
    user: { name: "Dana Kessler", email: "dana@acme.co", image: null },
  })),
}));

const loadDashboard = vi.fn<() => Promise<DashboardData>>();
vi.mock("@/server/dashboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/dashboard")>();
  return { ...actual, loadDashboard: () => loadDashboard() };
});

// The date-range filter (rendered in the header) is a client component that reads the router/query.
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
}));

import DashboardPage from "./page";

// UTC-midnight ISO for `daysAgo` before now — the series rows the rollup would have produced.
function dayIso(daysAgo: number): string {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - daysAgo * 86_400_000).toISOString();
}

const HEALTHY: DashboardData = {
  seriesOk: true,
  series: [
    { windowStart: dayIso(1), delivered: 40, dead: 0, blocked: 0, p95DurationMs: 210 },
    { windowStart: dayIso(0), delivered: 12, dead: 0, blocked: 0, p95DurationMs: 180 },
  ],
  paused: false,
  disabledDestinationCount: 0,
  pastDue: false,
};

beforeEach(() => {
  loadDashboard.mockReset();
});

async function renderPage() {
  render(
    await DashboardPage({
      params: Promise.resolve({ slug: "acme" }),
      searchParams: Promise.resolve({}),
    }),
  );
}

describe("DashboardPage", () => {
  it("renders outcome totals and the chart when deliveries exist", async () => {
    loadDashboard.mockResolvedValue(HEALTHY);
    await renderPage();

    expect(screen.getByRole("heading", { name: "Overview" })).toBeInTheDocument();
    // 40 + 12 delivered, 1 failed over the window.
    expect(screen.getByText("52")).toBeInTheDocument();
    // "Delivered"/"Failed" appear in both the stat tile and the chart legend — assert both surfaces exist.
    expect(screen.getAllByText("Delivered").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(1);
    // p95 tile shows the freshest measured day (today's 180ms).
    expect(screen.getByText("180 ms")).toBeInTheDocument();
    // The hand-rolled chart carries an aria summary — no chart library.
    expect(
      screen.getByRole("img", { name: /delivery outcomes over the last/i }),
    ).toBeInTheDocument();
    // Healthy account: no attention panel, no empty state.
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(screen.queryByText("No deliveries yet")).not.toBeInTheDocument();
  });

  it("shows the onboarding empty state (one CTA) when there are no deliveries yet", async () => {
    loadDashboard.mockResolvedValue({ ...HEALTHY, series: [] });
    await renderPage();

    expect(screen.getByText("No deliveries yet")).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: "Send a test webhook" });
    // Org-scoped: a bare /endpoints is not a route any more — it would 404.
    expect(cta).toHaveAttribute("href", "/org/acme/endpoints");
    // No chart / totals in the empty state.
    expect(screen.queryByRole("img", { name: /delivery outcomes/i })).not.toBeInTheDocument();
  });

  it("shows a scoped error banner when the series read failed (rest of the page still fine)", async () => {
    loadDashboard.mockResolvedValue({ ...HEALTHY, series: [], seriesOk: false });
    await renderPage();

    expect(screen.getByText(/couldn't load your delivery stats/i)).toBeInTheDocument();
    expect(screen.queryByText("No deliveries yet")).not.toBeInTheDocument();
  });

  it("surfaces resolvable issues in the needs-attention panel, linked and ordered", async () => {
    loadDashboard.mockResolvedValue({
      ...HEALTHY,
      paused: true,
      disabledDestinationCount: 2,
      pastDue: true,
      series: [{ windowStart: dayIso(0), delivered: 3, dead: 4, blocked: 0, p95DurationMs: 200 }],
    });
    await renderPage();

    const panel = screen.getByText("Needs attention").closest("div")!;
    const links = within(panel.parentElement as HTMLElement).getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    // Severity order: past due → paused → disabled destinations → dead deliveries.
    expect(hrefs).toEqual(["/billing", "/usage", "/destinations", "/deliveries?status=dead"]);
    expect(screen.getByText("2 destinations auto-disabled")).toBeInTheDocument();
    expect(screen.getByText("4 deliveries gave up")).toBeInTheDocument();
  });
});
