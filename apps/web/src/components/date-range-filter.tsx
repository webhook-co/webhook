"use client";

import {
  Calendar,
  type CalendarRange,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@webhook-co/ui";
import { Calendar as CalendarIcon, Check, ChevronDown } from "lucide-react";
import * as React from "react";

import {
  activeDateLabel,
  DATE_PRESETS,
  hasDateRange,
  isDatePreset,
  presetCalendarRange,
} from "@/lib/date-range";

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DateRangeValue {
  readonly range: string;
  readonly from: string;
  readonly to: string;
}

export interface DateRangeFilterProps {
  readonly value: DateRangeValue;
  /**
   * Apply a patch of URL params. A preset sends `{ range, from: "", to: "" }`; a calendar selection
   * sends `{ from, to, range: "" }` — the two date modes are mutually exclusive, so each clears the other.
   */
  readonly onApply: (patch: Record<string, string>) => void;
}

// The wire `?to=` is an EXCLUSIVE upper bound (received_at < to), shared with `--before` on the CLI for
// parity. On a calendar, though, clicking the end day means "INCLUDE that day" — so the picked end maps
// to the exclusive wire bound `day + 1`, and a wire bound reads back as the calendar end `to − 1`. `from`
// is an inclusive lower bound, so it maps straight through. Day math is UTC (`YYYY-MM-DD`, no tz lib).
function shiftUtcDay(ymd: string, delta: number): string | undefined {
  if (!YMD_RE.test(ymd)) return undefined; // a hand-edited non-calendar `?to=` (e.g. an ISO instant) → ignore
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + delta));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`;
}

// The date-range control: a single trigger opening ONE popover that holds both the relative presets and
// a graphical range calendar — no separate row. A Popover (not a DropdownMenu) hosts them so the calendar
// keeps normal keyboard behavior (a menu would hijack arrow keys). A valid preset OWNS the range (mirrors
// the parser, which ignores from/to under a preset); selecting calendar days clears the preset.
export function DateRangeFilter({ value, onApply }: DateRangeFilterProps) {
  const active = hasDateRange(value);

  function pickPreset(id: string) {
    onApply({ range: id, from: "", to: "" });
  }

  function pickRange(range: CalendarRange) {
    // The picked end day is inclusive → shift it to the exclusive wire bound (day + 1).
    onApply({
      from: range.from ?? "",
      to: range.to ? (shiftUtcDay(range.to, 1) ?? "") : "",
      range: "",
    });
  }

  // What the calendar shows. A valid preset OWNS the range (mirrors the parser, which ignores stray
  // from/to under a preset) — and the calendar HIGHLIGHTS the preset's own resolved span so the grid
  // reflects the active selection. Otherwise the inclusive calendar end reads the exclusive wire `to`
  // back as `to − 1`; a malformed (non-YYYY-MM-DD, e.g. hand-edited ISO) bound is dropped, not NaN.
  const presetActive = isDatePreset(value.range);
  const calendarValue: CalendarRange = presetActive
    ? presetCalendarRange(value.range)
    : {
        from: YMD_RE.test(value.from) ? value.from : undefined,
        to: value.to ? shiftUtcDay(value.to, -1) : undefined,
      };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Filter by received date: ${activeDateLabel(value)}`}
          className={[
            "inline-flex h-[42px] items-center gap-2 rounded-control border bg-surface px-3 text-base",
            "font-sans transition-[box-shadow,border-color] duration-[var(--wh-dur-fast)] ease-[var(--wh-ease-swift)]",
            "outline-none focus-visible:border-focus focus-visible:shadow-[var(--wh-focus-ring)]",
            active ? "border-focus text-fg" : "border-strong text-fg-secondary",
          ].join(" ")}
        >
          <CalendarIcon className="size-4 shrink-0 text-fg-muted" />
          <span>{activeDateLabel(value)}</span>
          <ChevronDown className="size-4 shrink-0 text-fg-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto gap-0 p-0">
        <div className="flex w-40 flex-col gap-0.5 border-r border-hairline p-1.5">
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => pickPreset(preset.id)}
              className="flex items-center justify-between rounded-control px-2.5 py-1.5 text-left text-sm text-fg-secondary outline-none hover:bg-surface-sunken hover:text-fg focus-visible:bg-surface-sunken focus-visible:text-fg"
            >
              <span>{preset.label}</span>
              {value.range === preset.id ? <Check className="size-4" /> : null}
            </button>
          ))}
          <div className="my-1 h-px bg-hairline" />
          <span className="px-2.5 py-1 text-xs font-medium text-fg-muted">Custom range</span>
        </div>
        <Calendar value={calendarValue} onChange={pickRange} />
      </PopoverContent>
    </Popover>
  );
}
