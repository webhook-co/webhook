import * as React from "react";

import { cn } from "../lib/cn";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/** One option in a popover-select control. `keywords` widen the search beyond the display label (a slug,
 *  a brand alias); `icon` is an optional leading visual (e.g. a provider logo). */
export interface PopoverSelectOption {
  readonly value: string;
  readonly label: string;
  readonly icon?: React.ReactNode;
  readonly keywords?: readonly string[];
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

/** Trailing check for the single-select variant (the chosen option). */
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

/** Leading checkbox for the multi-select variant. Presentational — NOT the interactive `Checkbox` primitive,
 *  which can't nest inside the option <button>; the row <button> owns aria-selected + the real selection. */
function CheckboxIndicator({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[1.125rem] shrink-0 items-center justify-center rounded-control border",
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

/** True if `needle` matches the option's label, value/slug, or any keyword (all case-insensitive). */
function matches(option: PopoverSelectOption, needle: string): boolean {
  if (option.label.toLowerCase().includes(needle)) return true;
  if (option.value.toLowerCase().includes(needle)) return true;
  return option.keywords?.some((k) => k.toLowerCase().includes(needle)) ?? false;
}

export interface PopoverSelectShellProps {
  readonly options: readonly PopoverSelectOption[];
  /** Accessible name for the control (the trigger announces "{label}: {summary}"). */
  readonly label: string;
  /** The trigger's summary text (the variant computes it: a label, a placeholder, "N selected", …). */
  readonly summary: string;
  /** Optional leading icon in the trigger (e.g. the sole-selected option's logo). */
  readonly summaryIcon?: React.ReactNode;
  /** Whether the control currently holds a value (drives the trigger's text/border treatment). */
  readonly hasValue: boolean;
  /** When set + hasValue, the trigger border reads as an active filter (border-focus) — the multi variant. */
  readonly accentBorderWhenSet?: boolean;
  /** Is this option currently selected? Drives aria-selected + the indicator. */
  readonly isSelected: (value: string) => boolean;
  /** The leading/trailing selection indicator style: a trailing check (single) or a leading checkbox (multi). */
  readonly indicator: "check" | "checkbox";
  /** Announce the listbox as multi-selectable. */
  readonly multiselectable?: boolean;
  /** Called when an option is chosen (click or Enter). */
  readonly onSelect: (value: string) => void;
  /** Close the popover after a selection (single-select) or keep it open to pick more (multi-select). */
  readonly closeOnSelect: boolean;
  /** Show the in-popover search box. Defaults on when there are more than 8 options. */
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly className?: string;
  readonly id?: string;
  readonly disabled?: boolean;
}

/**
 * The shared shell behind `Combobox` (single-select) and `MultiSelect` (multi-select): a `Popover` + an
 * optional search box + a keyboard-navigable `listbox`. It owns open state, the search query + filtering
 * (label / value / keywords), and full keyboard operation — the search box is an ARIA `combobox` whose
 * Up/Down/Home/End move a highlighted option (announced via `aria-activedescendant`) and Enter selects it.
 * The variants supply only what differs: the trigger summary, per-option selection state, the indicator
 * style, and whether a selection closes the popover.
 */
export function PopoverSelectShell({
  options,
  label,
  summary,
  summaryIcon,
  hasValue,
  accentBorderWhenSet = false,
  isSelected,
  indicator,
  multiselectable,
  onSelect,
  closeOnSelect,
  searchable = options.length > 8,
  searchPlaceholder = "Search…",
  className,
  id,
  disabled = false,
}: PopoverSelectShellProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listboxId = React.useId();
  // Key the DOM id off the option's *position*, never its value: a value can hold spaces or other
  // characters illegal in an id/IDREF, which would silently break aria-activedescendant for that option.
  const optionDomId = (index: number) => `${listboxId}-opt-${index}`;

  const needle = query.trim().toLowerCase();
  const filtered = needle ? options.filter((o) => matches(o, needle)) : options;

  // Keep the highlight on the first result whenever the query changes or the popover (re)opens.
  React.useEffect(() => {
    setActive(0);
  }, [needle, open]);

  // Keep the highlighted option visible while arrow-keying through a long list.
  React.useEffect(() => {
    if (!open) return;
    if (!filtered[active]) return;
    document.getElementById(optionDomId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, needle, open]);

  function select(value: string) {
    onSelect(value);
    if (closeOnSelect) {
      setOpen(false);
      setQuery("");
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(filtered.length - 1);
    } else if (e.key === "Enter") {
      const opt = filtered[active];
      if (opt) {
        e.preventDefault();
        select(opt.value);
      }
    }
  }

  const activeDescendant = open && filtered[active] ? optionDomId(active) : undefined;

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
            "inline-flex h-[2.625rem] items-center justify-between gap-2 rounded-control border bg-surface px-3 text-base font-sans",
            "transition-[box-shadow,border-color] duration-[var(--wh-dur-fast)] ease-[var(--wh-ease-swift)]",
            "outline-none focus-visible:border-focus focus-visible:shadow-[var(--wh-focus-ring)]",
            "disabled:cursor-not-allowed disabled:opacity-60",
            hasValue && accentBorderWhenSet ? "border-focus" : "border-strong",
            hasValue ? "text-fg" : "text-fg-secondary",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            {summaryIcon ? <span className="flex shrink-0 items-center">{summaryIcon}</span> : null}
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
              onKeyDown={onSearchKeyDown}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              role="combobox"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={activeDescendant}
              className="h-10 rounded-b-none border-0 pl-9 focus-visible:shadow-none"
            />
          </div>
        ) : null}
        <div
          role="listbox"
          id={listboxId}
          aria-label={label}
          aria-multiselectable={multiselectable || undefined}
          className="max-h-64 overflow-y-auto p-1"
        >
          {filtered.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-fg-muted">No matches</p>
          ) : (
            filtered.map((option, index) => {
              const sel = isSelected(option.value);
              const isActive = index === active;
              return (
                <button
                  key={option.value}
                  id={optionDomId(index)}
                  type="button"
                  role="option"
                  aria-selected={sel}
                  onClick={() => select(option.value)}
                  onMouseEnter={() => setActive(index)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-sm outline-none",
                    // The rows are real tabbable buttons; keep a visible indicator when Tab-focused, not just
                    // when arrow-key/hover-highlighted via `active` (WCAG 2.4.7).
                    "focus-visible:bg-surface-sunken focus-visible:text-fg",
                    isActive ? "bg-surface-sunken text-fg" : "text-fg-secondary",
                  )}
                >
                  {indicator === "checkbox" ? <CheckboxIndicator checked={sel} /> : null}
                  {option.icon ? (
                    <span className="flex shrink-0 items-center">{option.icon}</span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {indicator === "check" && sel ? <CheckIcon /> : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
