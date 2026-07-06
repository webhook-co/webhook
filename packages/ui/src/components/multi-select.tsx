import { PopoverSelectShell, type PopoverSelectOption } from "./popover-select-shell";

export type MultiSelectOption = PopoverSelectOption;

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

/**
 * A searchable MULTI-select — the multi-select face of the shared {@link PopoverSelectShell}: a
 * checkbox-style option list that stays open as you toggle, summarizing the selection ("All providers" /
 * a single label / "N selected") and highlighting the trigger border while a filter is active. Selection
 * preserves the option order for a stable URL/value. Fully keyboard-operable (arrows + Enter to toggle).
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  label,
  searchable,
  searchPlaceholder,
  className,
}: MultiSelectProps) {
  const selectedSet = new Set(selected);
  const soleSelected =
    selected.length === 1 ? options.find((o) => o.value === selected[0]) : undefined;
  const summary =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? (soleSelected?.label ?? selected[0]!)
        : `${selected.length} selected`;

  return (
    <PopoverSelectShell
      options={options}
      label={label}
      summary={summary}
      summaryIcon={soleSelected?.icon}
      hasValue={selected.length > 0}
      accentBorderWhenSet
      isSelected={(v) => selectedSet.has(v)}
      indicator="checkbox"
      multiselectable
      closeOnSelect={false}
      onSelect={(v) => {
        const next = new Set(selectedSet);
        if (next.has(v)) next.delete(v);
        else next.add(v);
        // Emit in option order for a stable URL/value (not selection order).
        onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
      }}
      searchable={searchable}
      searchPlaceholder={searchPlaceholder}
      className={className}
    />
  );
}
