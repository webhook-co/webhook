import { isDatePreset, presetLabel, resolvePresetBound } from "./date-range";

// Resolve the /dashboard chart window from the URL (?range= preset, or ?from=&to= custom) into the two
// numbers the read + chart model need: `days` (how many UTC days to render) and `endMs` (the day the window
// ends on). Pure + deterministic (now injected) so it's unit-testable. Shares the events-page date vocabulary
// (DATE_PRESETS, resolvePresetBound) so the picker behaves identically — including the calendar's EXCLUSIVE
// upper bound (`?to=` is picked-end + 1), which the events wire established.

const DAY_MS = 86_400_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Default window when no filter is set. */
export const DASHBOARD_DEFAULT_DAYS = 14;
/** Cap so the chart stays readable and the read stays bounded, no matter what a hand-edited URL asks for. */
export const DASHBOARD_MAX_DAYS = 90;

export interface DashboardWindow {
  /** Number of UTC days the chart renders (1..DASHBOARD_MAX_DAYS). */
  readonly days: number;
  /** The instant whose UTC day is the window's LAST (newest) day. */
  readonly endMs: number;
  /** Human label for the active window (drives the stat-tile hint). */
  readonly label: string;
}

export interface DashboardWindowParams {
  readonly range?: string;
  readonly from?: string;
  readonly to?: string;
}

const clampDays = (n: number): number => Math.max(1, Math.min(DASHBOARD_MAX_DAYS, Math.round(n)));

const ymd = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

/**
 * Resolve the window. Precedence mirrors the picker/parser: a valid preset OWNS the window (from/to ignored);
 * otherwise a valid custom `from`+`to` (both `YYYY-MM-DD`, `to` exclusive) defines it; otherwise the default.
 * Anything malformed falls back to the default rather than throwing — a hand-edited URL can't break the page.
 */
export function resolveDashboardWindow(
  params: DashboardWindowParams,
  nowMs: number,
): DashboardWindow {
  // Preset (e.g. ?range=7d) — window is [now − preset, now].
  if (isDatePreset(params.range)) {
    const bound = resolvePresetBound(params.range, new Date(nowMs));
    if (bound) {
      return {
        days: clampDays((nowMs - bound.getTime()) / DAY_MS),
        endMs: nowMs,
        label: presetLabel(params.range) ?? `Last ${DASHBOARD_DEFAULT_DAYS} days`,
      };
    }
  }

  // Custom calendar range (?from=YYYY-MM-DD&to=YYYY-MM-DD, `to` EXCLUSIVE) — window is [from, to − 1 day].
  const { from, to } = params;
  if (from && to && YMD.test(from) && YMD.test(to)) {
    const fromMs = Date.parse(`${from}T00:00:00Z`);
    const toExclMs = Date.parse(`${to}T00:00:00Z`);
    if (Number.isFinite(fromMs) && Number.isFinite(toExclMs) && toExclMs > fromMs) {
      const endMs = toExclMs - DAY_MS; // last INCLUDED day
      return {
        days: clampDays((toExclMs - fromMs) / DAY_MS),
        endMs,
        label: `${from} – ${ymd(endMs)}`,
      };
    }
  }

  return {
    days: DASHBOARD_DEFAULT_DAYS,
    endMs: nowMs,
    label: `Last ${DASHBOARD_DEFAULT_DAYS} days`,
  };
}
