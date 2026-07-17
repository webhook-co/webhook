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

/**
 * The default window for the ORG-WIDE events browse when no `?range=` is set.
 *
 * The per-endpoint browse defaults to all time; the org-wide one must not. Measured: the keyset's `limit + 1`
 * early-stop does NOT hold once a residual filter (a search term, a sparse status) makes the planner abandon
 * the ordered index — the resulting Sort is a BLOCKING operator that consumes the entire input before emitting
 * row 1. 578ms at 1.8M rows, ~32s extrapolated at 100M; 29ms with a date bound.
 *
 * 7d is also the Free plan's retention window, so for most orgs it hides nothing that still exists.
 *
 * It is only a DISCLOSED default because the chip names the window AND {@link ALL_TIME_RANGE} makes all-time
 * reachable in one click. Without that escape hatch it is a SILENT FILTER — which is exactly what shipped:
 * this comment claimed "Any time is one click away" while no such control existed.
 */
export const DEFAULT_ORG_EVENTS_RANGE = "7d";

/**
 * The explicit "no date bound" token (`?range=all`) — the escape hatch from {@link DEFAULT_ORG_EVENTS_RANGE}.
 *
 * It MUST be an explicit token rather than "clear the params", and that is not a style choice. The filter
 * bar's applyPatch DELETES a key whose value is empty, and the page applies the default when the date params
 * are ABSENT — so a control that cleared `range`/`from`/`to` would round-trip straight back to 7d, silently.
 * The same shape already shipped as a bug once: a custom calendar range pushed `range: ""`, the default
 * re-injected itself, and the reader saw 7 days while the chip read "Custom range".
 *
 * A present, non-empty token survives applyPatch, survives the URL, and reads as intent to the page.
 */
export const ALL_TIME_RANGE = "all";

const PRESET_BY_ID = new Map(DATE_PRESETS.map((p) => [p.id, p]));

/** True when `id` names a known preset (a hand-edited `?range=foo` is not). */
export function isDatePreset(id: string | null | undefined): id is string {
  return typeof id === "string" && PRESET_BY_ID.has(id);
}

/**
 * True when `?range=` carries a DELIBERATE choice — a window preset, or the explicit all-time token.
 *
 * This is the distinction the default turns on, and it is NOT "is the param present". A hand-edited
 * `?range=bogus` must fall back to the default rather than to all-time: an unrecognised token is a typo, and
 * resolving a typo into "scan the org's entire retained history" is how a stray URL becomes a ~32s query at
 * 100M rows. Absent, empty, and junk all mean "no choice made" — only a KNOWN token is intent.
 */
export function isDateIntent(id: string | null | undefined): boolean {
  // Not `isDatePreset(id) || id === ALL_TIME_RANGE`: isDatePreset is a type predicate, so TS narrows `id` to
  // null|undefined on the right of the `||` and flags the comparison as impossible.
  return typeof id === "string" && (PRESET_BY_ID.has(id) || id === ALL_TIME_RANGE);
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
  if (value.range === ALL_TIME_RANGE) return "Any time";
  const preset = presetLabel(value.range);
  if (preset !== undefined) return preset;
  if (hasText(value.from) || hasText(value.to)) return "Custom range";
  return "Date range";
}

/**
 * True when the reader has made an explicit date choice — a preset, all-time, or a custom from/to.
 *
 * All-time counts. It bounds nothing, but it IS a choice, and the bar uses this to decide whether there is
 * anything to clear: a reader who picked "Any time" must be able to get back to the default.
 */
export function hasDateRange(value: {
  range?: string | null;
  from?: string | null;
  to?: string | null;
}): boolean {
  return isDateIntent(value.range) || hasText(value.from) || hasText(value.to);
}

/**
 * The window actually in force — THE single rule, shared by the page (which resolves it into a db bound) and
 * the filter bar (which labels the chip with it). Returns a `?range=` token, or "" when a custom from/to owns
 * the window.
 *
 * It exists because those two used to decide independently and drifted the moment the URL had no `?range=`:
 * the page applied its default server-side while the bar read the (absent) param, so the reader got 7 days
 * under a chip that said "Date range". A default nobody can see is a silent filter — the precise thing this
 * module claimed it wasn't. Both callers now ask the same question and cannot disagree.
 *
 * The precedence mirrors parseEventFilters: an explicit choice ALWAYS beats the fallback, and a custom
 * from/to suppresses it entirely (a naive `range || fallback` re-injects the default over a user's calendar
 * dates — that bug shipped to prod once already).
 */
export function effectiveDateRange(
  value: { range?: string | null; from?: string | null; to?: string | null },
  fallback: string,
): string {
  return hasDateRange(value) ? (value.range ?? "") : fallback;
}
