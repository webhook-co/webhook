import type { DeliveryStatsDay } from "@webhook-co/db";

// Pure model for the /dashboard delivery-outcomes chart. The rollup read (readDeliveryStatsSeries) OMITS a
// day with no deliveries — but a chart needs a continuous x-axis, so this fills the last `days` UTC days with
// zeros, keying stored rows by their UTC calendar date. Kept pure (no DB, no Date.now default) so the bar
// geometry and totals are unit-testable and deterministic; the SVG component is a dumb renderer over this.

/** One day's bar: failed = dead + blocked (both are failure outcomes the user can act on). */
export interface DashboardChartBar {
  /** UTC calendar date, YYYY-MM-DD (the map key + chart x-value). */
  readonly date: string;
  /** Short human label for the axis, e.g. "Jul 7" (UTC). */
  readonly label: string;
  readonly delivered: number;
  readonly failed: number;
  readonly total: number;
}

export interface DashboardChartModel {
  readonly bars: DashboardChartBar[];
  /** Largest single-day total — the y-axis scale. At least 1 so an all-zero window still divides cleanly. */
  readonly maxTotal: number;
  readonly totalDelivered: number;
  readonly totalDead: number;
  readonly totalBlocked: number;
  /** dead + blocked across the window. */
  readonly totalFailed: number;
  /** p95 latency (ms) of the most recent day that measured one; null if none in the window. */
  readonly latestP95Ms: number | null;
  /** True once any delivery (any outcome) exists in the window — drives empty-state vs chart. */
  readonly hasAnyDelivery: boolean;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** UTC YYYY-MM-DD for a ms instant (the join key between filled days and stored rows). */
function utcDateKey(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * Build the chart model for the `days` UTC days ending on `endMs`'s day (inclusive), oldest→newest. `endMs`
 * is usually now, but a custom date-range filter ends the window on a past day. Missing days are zero-filled
 * so the axis is continuous. `latestP95Ms` walks newest→oldest and takes the first measured value (a p95 is
 * per-day and not averageable across days, so we surface the freshest one).
 */
export function buildDashboardChart(
  series: readonly DeliveryStatsDay[],
  days: number,
  endMs: number,
): DashboardChartModel {
  const DAY_MS = 86_400_000;
  // Key stored rows by their UTC date. windowStart is a UTC-midnight ISO string from the rollup.
  const byDate = new Map<string, DeliveryStatsDay>();
  for (const row of series) byDate.set(utcDateKey(Date.parse(row.windowStart)), row);

  const endStart = Date.UTC(
    new Date(endMs).getUTCFullYear(),
    new Date(endMs).getUTCMonth(),
    new Date(endMs).getUTCDate(),
  );

  const bars: DashboardChartBar[] = [];
  let totalDelivered = 0;
  let totalDead = 0;
  let totalBlocked = 0;
  for (let i = days - 1; i >= 0; i--) {
    const dayMs = endStart - i * DAY_MS;
    const key = utcDateKey(dayMs);
    const row = byDate.get(key);
    const delivered = row?.delivered ?? 0;
    const dead = row?.dead ?? 0;
    const blocked = row?.blocked ?? 0;
    const failed = dead + blocked;
    totalDelivered += delivered;
    totalDead += dead;
    totalBlocked += blocked;
    const d = new Date(dayMs);
    bars.push({
      date: key,
      label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`,
      delivered,
      failed,
      total: delivered + failed,
    });
  }

  // Freshest measured p95: newest→oldest, first non-null.
  let latestP95Ms: number | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    if (bar === undefined) continue;
    const row = byDate.get(bar.date);
    if (row && row.p95DurationMs !== null) {
      latestP95Ms = row.p95DurationMs;
      break;
    }
  }

  const maxTotal = Math.max(1, ...bars.map((b) => b.total));
  const totalFailed = totalDead + totalBlocked;
  return {
    bars,
    maxTotal,
    totalDelivered,
    totalDead,
    totalBlocked,
    totalFailed,
    latestP95Ms,
    hasAnyDelivery: totalDelivered + totalFailed > 0,
  };
}
