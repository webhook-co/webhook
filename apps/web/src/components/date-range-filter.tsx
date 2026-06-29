"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@webhook-co/ui";
import { ArrowRight, Calendar, Check, ChevronDown } from "lucide-react";
import * as React from "react";

import { activeDateLabel, DATE_PRESETS, hasDateRange, isDatePreset } from "@/lib/date-range";

export interface DateRangeValue {
  readonly range: string;
  readonly from: string;
  readonly to: string;
}

export interface DateRangeFilterProps {
  readonly value: DateRangeValue;
  /**
   * Apply a patch of URL params. A preset sends `{ range, from: "", to: "" }`; a custom date sends
   * `{ from|to, range: "" }` — the two date modes are mutually exclusive, so each clears the other.
   */
  readonly onApply: (patch: Record<string, string>) => void;
  /** Whether the custom date inputs are revealed. Owned by the parent so a "Clear filters" resets it. */
  readonly customOpen: boolean;
  readonly onCustomOpenChange: (open: boolean) => void;
}

// The date-range control: a single trigger whose label reflects the active range (a preset name,
// "Custom range", or a neutral "Date range"). Presets live in a keyboard-navigable dropdown (the right
// pattern for picking one of a few). "Custom range…" reveals two native date inputs INLINE (not nested
// in the menu) so they keep correct keyboard behavior — arrow keys step the date instead of being
// hijacked by menu navigation — and the native picker icon follows the theme (color-scheme).
//
// A valid preset OWNS the date range (it mirrors the parser, which ignores from/to when a preset is
// set), so an active preset suppresses the custom state even if stray from/to ride in the URL. Entering
// custom mode does NOT eagerly clear the preset — the preset stays applied (no flash of unfiltered
// results) until the first custom date is entered, which clears it in the same push.
export function DateRangeFilter({
  value,
  onApply,
  customOpen,
  onCustomOpenChange,
}: DateRangeFilterProps) {
  const presetActive = isDatePreset(value.range);
  const customActive = !presetActive && (value.from !== "" || value.to !== "");
  const showCustom = customActive || customOpen;
  const active = hasDateRange(value);
  const fromRef = React.useRef<HTMLInputElement>(null);
  // Set when "Custom range…" is chosen so the menu's close handler moves focus to the From input
  // (instead of Radix's default focus-restore to the trigger, which would otherwise win the race).
  const focusFromOnClose = React.useRef(false);

  function pickPreset(id: string) {
    onCustomOpenChange(false);
    onApply({ range: id, from: "", to: "" });
  }

  function openCustom() {
    // Reveal the inputs only — no URL write. The active preset (if any) stays applied until the first
    // custom date is entered (the date onChange clears it), avoiding both a wasted unfiltered refetch and
    // a stale-`value.range` read right after a preset pick.
    focusFromOnClose.current = true;
    onCustomOpenChange(true);
  }

  function setCustom(patch: { from?: string; to?: string }) {
    onCustomOpenChange(true);
    onApply({ ...patch, range: "" });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
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
            <Calendar className="size-4 shrink-0 text-fg-muted" />
            <span>{activeDateLabel(value)}</span>
            <ChevronDown className="size-4 shrink-0 text-fg-muted" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-[12rem]"
          onCloseAutoFocus={(e) => {
            // Beat Radix's focus-restore-to-trigger when entering custom mode: focus the From input.
            if (focusFromOnClose.current) {
              focusFromOnClose.current = false;
              e.preventDefault();
              fromRef.current?.focus();
            }
          }}
        >
          {DATE_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              onSelect={() => pickPreset(preset.id)}
              className="justify-between"
            >
              <span>{preset.label}</span>
              {value.range === preset.id ? <Check className="size-4" /> : null}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openCustom} className="justify-between">
            <span>Custom range…</span>
            {customActive ? <Check className="size-4" /> : null}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {showCustom ? (
        <div className="flex items-center gap-1.5">
          <Input
            ref={fromRef}
            type="date"
            aria-label="From date"
            value={value.from}
            max={value.to || undefined}
            onChange={(e) => setCustom({ from: e.target.value })}
            className="w-[150px]"
          />
          <ArrowRight aria-hidden className="size-4 shrink-0 text-fg-muted" />
          <Input
            type="date"
            aria-label="To date (exclusive — events before this day)"
            value={value.to}
            min={value.from || undefined}
            onChange={(e) => setCustom({ to: e.target.value })}
            className="w-[150px]"
          />
        </div>
      ) : null}
    </div>
  );
}
