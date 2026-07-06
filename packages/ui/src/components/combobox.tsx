import { PopoverSelectShell, type PopoverSelectOption } from "./popover-select-shell";

export type ComboboxOption = PopoverSelectOption;

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

/**
 * A searchable SINGLE-select dropdown — the single-select face of the shared {@link PopoverSelectShell}
 * (same search + optional per-option `icon`). Unlike the native `Select` it supports search + rich option
 * visuals + full keyboard nav; unlike `MultiSelect` it holds ONE value, marks the chosen option with a
 * trailing check, and closes on select. Re-selecting the current value is a no-op (parity with `<select>`).
 */
export function Combobox({
  options,
  value,
  onChange,
  label,
  placeholder = "Select…",
  searchable,
  searchPlaceholder,
  className,
  id,
  disabled,
}: ComboboxProps) {
  const selected = options.find((o) => o.value === value);
  return (
    <PopoverSelectShell
      options={options}
      label={label}
      summary={selected?.label ?? placeholder}
      summaryIcon={selected?.icon}
      hasValue={Boolean(selected)}
      isSelected={(v) => v === value}
      indicator="check"
      closeOnSelect
      onSelect={(v) => {
        if (v !== value) onChange(v); // a no-op re-select shouldn't fire onChange (parity with <select>)
      }}
      searchable={searchable}
      searchPlaceholder={searchPlaceholder}
      className={className}
      id={id}
      disabled={disabled}
    />
  );
}
