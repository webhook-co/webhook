import * as React from "react";

import { cn } from "../lib/cn";

/** A half-open date range as `YYYY-MM-DD` UTC day strings (the filter wire format). */
export interface CalendarRange {
  readonly from?: string;
  readonly to?: string;
}

export interface CalendarProps {
  readonly value: CalendarRange;
  readonly onChange: (range: CalendarRange) => void;
  /** The month to show first (a `YYYY-MM-DD`); defaults to the range end/start, else `today`. */
  readonly defaultMonth?: string;
  /** Today (`YYYY-MM-DD`), injected for deterministic tests. Defaults to the real UTC today. */
  readonly today?: string;
  readonly className?: string;
}

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function toYmd(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}
function parseYmd(value: string | undefined): { y: number; m: number; d: number } | null {
  const match = value ? YMD_RE.exec(value) : null;
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) };
}
// Zero-padded YYYY-MM-DD strings compare lexicographically == chronologically.
function utcTodayYmd(): string {
  const now = new Date();
  return toYmd(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/**
 * A month-grid range calendar (UTC, no timezone lib — days are `YYYY-MM-DD` strings, which compare
 * chronologically). Click a day to start the range, click another to finish it; clicking before the
 * pending start restarts it. Endpoints are filled, the span between is shaded. Matches the half-open
 * `from`/`to` semantics of the events filter (the `to` day is the exclusive upper bound elsewhere; here
 * it's the inclusive click target — the filter bar labels the bound).
 */
export function Calendar({ value, onChange, defaultMonth, today, className }: CalendarProps) {
  const todayStr = today ?? utcTodayYmd();
  const anchor =
    parseYmd(defaultMonth) ?? parseYmd(value.to) ?? parseYmd(value.from) ?? parseYmd(todayStr)!;
  const [view, setView] = React.useState({ y: anchor.y, m: anchor.m });

  // The in-progress start day, tracked LOCALLY so completing a range never depends on the first click's
  // `value` change having committed (the prop is URL-derived and lags an RSC navigation). Reset when the
  // controlled range is cleared/replaced externally.
  const [pendingStart, setPendingStart] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!value.from && !value.to) setPendingStart(null);
  }, [value.from, value.to]);

  function shiftMonth(delta: number) {
    setView((v) => {
      const next = v.m + delta;
      return { y: v.y + Math.floor(next / 12), m: ((next % 12) + 12) % 12 };
    });
  }

  function pick(day: string) {
    // The pending start is the locally-tracked first click, else a partial range carried in by the prop
    // (from set, to unset — e.g. reopening after one click), else none.
    const start = pendingStart ?? (value.from && !value.to ? value.from : null);
    if (start === null || day < start) {
      // Begin (or restart, if the click lands before the pending start) the range.
      setPendingStart(day);
      onChange({ from: day });
    } else {
      // Complete the range from the pending start (not the lagging prop).
      setPendingStart(null);
      onChange({ from: start, to: day });
    }
  }

  // What to highlight: while a start is pending (awaiting the second click), show only that day; once a
  // range is complete, show the prop's from/to span.
  const hiFrom = pendingStart ?? value.from;
  const hiTo = pendingStart ? undefined : value.to;

  const firstWeekday = new Date(Date.UTC(view.y, view.m, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(toYmd(view.y, view.m, d));

  return (
    <div className={cn("w-[16rem] select-none p-2", className)}>
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => shiftMonth(-1)}
          className="flex size-7 items-center justify-center rounded-control text-fg-secondary outline-none hover:bg-surface-sunken hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)]"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
            <path
              d="m15 18-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="text-sm font-medium text-fg" aria-live="polite">
          {MONTHS[view.m]} {view.y}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => shiftMonth(1)}
          className="flex size-7 items-center justify-center rounded-control text-fg-secondary outline-none hover:bg-surface-sunken hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)]"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
            <path
              d="m9 18 6-6-6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5" role="grid">
        {WEEKDAYS.map((wd) => (
          <div
            key={wd}
            className="py-1 text-center text-xs font-medium text-fg-muted"
            aria-hidden="true"
          >
            {wd}
          </div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`b${i}`} />;
          const isFrom = day === hiFrom;
          const isTo = day === hiTo;
          const inRange = hiFrom && hiTo ? day > hiFrom && day < hiTo : false;
          const isToday = day === todayStr;
          return (
            <button
              key={day}
              type="button"
              role="gridcell"
              aria-label={day}
              aria-pressed={isFrom || isTo}
              onClick={() => pick(day)}
              className={cn(
                "flex h-8 items-center justify-center rounded-control text-sm tabular-nums outline-none",
                "focus-visible:shadow-[var(--wh-focus-ring)]",
                isFrom || isTo
                  ? "bg-surface-inverse font-semibold text-fg-on-inverse"
                  : inRange
                    ? // A clear tint of the high-contrast selection colour (visible in BOTH themes —
                      // surface-sunken alone was nearly invisible against the popover surface).
                      "bg-surface-inverse/20 font-medium text-fg"
                    : "text-fg-secondary hover:bg-surface-inverse/10 hover:text-fg",
                // Today (when not itself a range endpoint) gets a ring so it's findable against the tint.
                isToday &&
                  !(isFrom || isTo) &&
                  "font-semibold text-fg ring-1 ring-inset ring-strong",
              )}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
