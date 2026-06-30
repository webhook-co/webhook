// The events filter bar's date-range vocabulary. Two ways to bound the received-at range:
//   • a relative PRESET (`?range=7d`) — "the last N", resolved to an absolute lower bound at read time;
//   • a CUSTOM range (`?from=&to=`) — explicit calendar bounds (the existing 1a params).
// Both resolve down to the single `receivedAfter`/`receivedBefore` instants the db already filters on, so
// this is a web-only convenience — no contract/db/CLI/MCP change. `now` is injected so resolution is
// deterministic in tests (and is evaluated server-side at render time, client-side on navigation).

export interface DatePreset {
  /** The URL token (`?range=`). */
  readonly id: string;
  /** The human label shown on the trigger + in the menu. */
  readonly label: string;
  /** The window length back from `now`, in milliseconds. */
  readonly ms: number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The relative presets, newest window first. Order is the menu order. */
export const DATE_PRESETS: readonly DatePreset[] = [
  { id: "1h", label: "Last hour", ms: HOUR },
  { id: "24h", label: "Last 24 hours", ms: 24 * HOUR },
  { id: "7d", label: "Last 7 days", ms: 7 * DAY },
  { id: "30d", label: "Last 30 days", ms: 30 * DAY },
];

const PRESET_BY_ID = new Map(DATE_PRESETS.map((p) => [p.id, p]));

/** True when `id` names a known preset (a hand-edited `?range=foo` is not). */
export function isDatePreset(id: string | null | undefined): id is string {
  return typeof id === "string" && PRESET_BY_ID.has(id);
}

/** The absolute lower bound for a preset (`now − window`), or undefined for an unknown id. */
export function resolvePresetBound(id: string | null | undefined, now: Date): Date | undefined {
  const preset = typeof id === "string" ? PRESET_BY_ID.get(id) : undefined;
  return preset ? new Date(now.getTime() - preset.ms) : undefined;
}

/** The label for a preset id, or undefined for an unknown id. */
export function presetLabel(id: string | null | undefined): string | undefined {
  return typeof id === "string" ? PRESET_BY_ID.get(id)?.label : undefined;
}

function toUtcYmd(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`;
}

/**
 * The calendar day range a relative preset covers — `[day of (now − window), today]` (UTC) — so the
 * grid can HIGHLIGHT the active preset's span. `now` is injected for tests. Sub-day presets (1h/24h)
 * collapse to one or two calendar days, which is the honest day-granular view of the window.
 */
export function presetCalendarRange(
  id: string | null | undefined,
  now: Date = new Date(),
): { from?: string; to?: string } {
  const start = resolvePresetBound(id, now);
  if (!start) return {};
  return { from: toUtcYmd(start), to: toUtcYmd(now) };
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The trigger button's label. A valid preset OWNS the range (mirroring the parser), so it wins. For a
 * custom from/to we label the trigger "Custom range" rather than summarizing the dates — the inline
 * date inputs are always visible alongside the trigger when a custom range is set, so re-stating the
 * dates here would duplicate them AND would have to encode the exclusive-`to` semantics (`to` is a
 * half-open upper bound, so "Jun 1 – Jun 8" would falsely read as including Jun 8). Otherwise a neutral
 * prompt.
 */
export function activeDateLabel(value: {
  range?: string | null;
  from?: string | null;
  to?: string | null;
}): string {
  const preset = presetLabel(value.range);
  if (preset !== undefined) return preset;
  if (hasText(value.from) || hasText(value.to)) return "Custom range";
  return "Date range";
}

/** True when any date bound is active — a valid preset, or a non-empty custom from/to. */
export function hasDateRange(value: {
  range?: string | null;
  from?: string | null;
  to?: string | null;
}): boolean {
  return isDatePreset(value.range) || hasText(value.from) || hasText(value.to);
}
