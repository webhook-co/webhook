import * as React from "react";

import { cn } from "../lib/cn";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
}

export interface MultiSelectProps {
  readonly options: readonly MultiSelectOption[];
  readonly selected: readonly string[];
  readonly onChange: (selected: string[]) => void;
  /** Trigger text when nothing is selected (e.g. "All providers"). */
  readonly placeholder: string;
  /** Accessible name for the control (the trigger announces "{label}: {summary}"). */
  readonly label: string;
  /** Show the in-popover search box. Defaults on when there are more than 8 options. */
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly className?: string;
}

function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-4 shrink-0 text-fg-muted"
    >
      <path
        d="m6 9 6 6 6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="size-4 shrink-0 text-fg-muted"
    >
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.2-3.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// A decorative checkbox indicator mirroring the `Checkbox` primitive's visuals — the row <button> owns
// the toggle + the accessible `aria-selected`, so the box stays presentational (no controlled-state coupling).
function CheckIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-control border",
        checked ? "border-transparent bg-surface-inverse text-fg-on-inverse" : "border-strong",
      )}
    >
      {checked ? (
        <svg viewBox="0 0 24 24" fill="none" className="size-3.5">
          <path
            d="m5 12 5 5L19 7"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}

/**
 * A searchable multi-select, built on `Popover` + a filtered, checkbox-style option list (NOT a
 * DropdownMenu — its arrow-key/typeahead menu semantics would fight the search box). The trigger
 * matches the native `Select` control surface and summarizes the selection ("All providers" / a single
 * label / "N selected"). Selection preserves the option order for a stable URL/value.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  label,
  searchable = options.length > 8,
  searchPlaceholder = "Search…",
  className,
}: MultiSelectProps) {
  const [query, setQuery] = React.useState("");
  const selectedSet = new Set(selected);
  const needle = query.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;

  function toggle(value: string) {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  }

  const summary =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? (options.find((o) => o.value === selected[0])?.label ?? selected[0])
        : `${selected.length} selected`;

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${summary}`}
          className={cn(
            "inline-flex h-[42px] items-center justify-between gap-2 rounded-control border bg-surface px-3 text-base font-sans",
            "transition-[box-shadow,border-color] duration-[var(--wh-dur-fast)] ease-[var(--wh-ease-swift)]",
            "outline-none focus-visible:border-focus focus-visible:shadow-[var(--wh-focus-ring)]",
            selected.length > 0 ? "border-focus text-fg" : "border-strong text-fg-secondary",
            className,
          )}
        >
          <span className="truncate">{summary}</span>
          <ChevronIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-52 p-0">
        {searchable ? (
          <div className="relative border-b border-hairline">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
              <SearchIcon />
            </span>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-10 rounded-b-none border-0 pl-9 focus-visible:shadow-none"
            />
          </div>
        ) : null}
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          className="max-h-64 overflow-y-auto p-1"
        >
          {filtered.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-fg-muted">No matches</p>
          ) : (
            filtered.map((option) => {
              const checked = selectedSet.has(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => toggle(option.value)}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-sm text-fg-secondary outline-none hover:bg-surface-sunken hover:text-fg focus-visible:bg-surface-sunken focus-visible:text-fg"
                >
                  <CheckIndicator checked={checked} />
                  <span className="truncate">{option.label}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
