import "server-only";

import { readDeliveryStatsSeries, type DeliveryStatsDay } from "@webhook-co/db";
import { withTenant } from "@webhook-co/db/client";
import { readBillingSummary } from "@webhook-co/db/reads";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { loadDestinations } from "./replay-destinations";
import { loadUsage } from "./usage";

// The read layer for the /dashboard overview. It composes signals that ALREADY have Lane reads (usage pause,
// auto-disabled destinations, billing status) plus the new delivery-stats series — each fault-isolated, so a
// blip in one signal degrades that tile rather than 500-ing the landing page a user hits on every login. The
// series is the display cache from the hourly rollup (migration 0063); everything downstream is O(days).

/** How many trailing days the overview chart + totals cover. */
export const DASHBOARD_WINDOW_DAYS = 14;

export interface DashboardData {
  /** Daily delivery-outcome series (oldest→newest); [] on a read fault (chart renders empty). */
  readonly series: DeliveryStatsDay[];
  /** False when the series read itself failed — lets the page distinguish "no data yet" from "couldn't load". */
  readonly seriesOk: boolean;
  /** ingest paused at the event cap. */
  readonly paused: boolean;
  /** destinations auto-disabled by persistent failure. */
  readonly disabledDestinationCount: number;
  /** billing subscription is past_due. */
  readonly pastDue: boolean;
}

async function loadSeries(orgId: string): Promise<{ series: DeliveryStatsDay[]; ok: boolean }> {
  try {
    const series = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) =>
        readDeliveryStatsSeries(tx, DASHBOARD_WINDOW_DAYS, Date.now()),
      ),
    );
    return { series, ok: true };
  } catch (error) {
    logActionError("dashboard.series_failed", error);
    return { series: [], ok: false };
  }
}

async function loadPastDue(orgId: string): Promise<boolean> {
  try {
    // The raw subscription status only (no Stripe round-trip) — the overview needs the flag, not the detail.
    const billing = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) => readBillingSummary(tx)),
    );
    return billing?.status === "past_due";
  } catch (error) {
    logActionError("dashboard.billing_failed", error);
    return false;
  }
}

/**
 * Load everything the overview needs, in parallel and independently fault-isolated. Never throws: a failed
 * signal falls back to its safe "nothing to flag" default so the page always renders. `deadCount` for the
 * attention panel is derived from `series` by the page (the rollup already carries it), so no extra read.
 */
export async function loadDashboard(orgId: string): Promise<DashboardData> {
  const [series, usage, destinations, pastDue] = await Promise.all([
    loadSeries(orgId),
    loadUsage(orgId),
    loadDestinations(orgId),
    loadPastDue(orgId),
  ]);

  return {
    series: series.series,
    seriesOk: series.ok,
    paused: usage.status === "ok" ? usage.usage.paused : false,
    disabledDestinationCount:
      destinations.status === "ok"
        ? destinations.items.filter((d) => d.disabledAt !== null).length
        : 0,
    pastDue,
  };
}
