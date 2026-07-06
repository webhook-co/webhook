import * as React from "react";

import { cn } from "../lib/cn";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Optional leading visual (e.g. a provider logo) shown before the label in the list + trigger. */
  readonly icon?: React.ReactNode;
}

export interface ComboboxProps {
  readonly options: readonly ComboboxOption[];
  /** The currently selected option value (single-select). */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Accessible name for the control (the trigger announces "{label}: {summary}"). */
  readonly label: string;
  /** Trigger text when `value` matches no option. */
  readonly placeholder?: string;
  /** Show the in-popover search box. Defaults on when there are more than 8 options. */
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly className?: string;
  /** Optional id on the trigger so an external `<Label htmlFor>` associates with it. */
  readonly id?: string;
  /** When true, the control can't be opened (mirrors a disabled native select). */
  readonly disabled?: boolean;
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

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4 shrink-0 text-fg">
      <path
        d="m5 12 5 5L19 7"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A searchable SINGLE-select dropdown, built on `Popover` + a filtered option list — the single-select
 * sibling of `MultiSelect` (same search + optional per-option `icon`, e.g. a provider logo). Unlike the
 * native `Select` it supports search and rich option visuals; unlike `MultiSelect` it holds ONE value,
 * marks the chosen option with a check, and closes on select. The trigger shows the selected option's
 * icon + label (or `placeholder` when the value matches nothing).
 */
export function Combobox({
  options,
  value,
  onChange,
  label,
  placeholder = "Select…",
  searchable = options.length > 8,
  searchPlaceholder = "Search…",
  className,
  id,
  disabled = false,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const needle = query.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;

  const selected = options.find((o) => o.value === value);
  const summary = selected?.label ?? placeholder;

  function choose(next: string) {
    onChange(next);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled) return;
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-label={`${label}: ${summary}`}
          className={cn(
            "inline-flex h-[42px] items-center justify-between gap-2 rounded-control border bg-surface px-3 text-base font-sans",
            "transition-[box-shadow,border-color] duration-[var(--wh-dur-fast)] ease-[var(--wh-ease-swift)]",
            "outline-none focus-visible:border-focus focus-visible:shadow-[var(--wh-focus-ring)]",
            "disabled:cursor-not-allowed disabled:opacity-60",
            selected ? "border-strong text-fg" : "border-strong text-fg-secondary",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected?.icon ? (
              <span className="flex shrink-0 items-center">{selected.icon}</span>
            ) : null}
            <span className="truncate">{summary}</span>
          </span>
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
        <div role="listbox" aria-label={label} className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-fg-muted">No matches</p>
          ) : (
            filtered.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => choose(option.value)}
                  className="flex w-full cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-sm text-fg-secondary outline-none hover:bg-surface-sunken hover:text-fg focus-visible:bg-surface-sunken focus-visible:text-fg"
                >
                  {option.icon ? (
                    <span className="flex shrink-0 items-center">{option.icon}</span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {isSelected ? <CheckIcon /> : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
