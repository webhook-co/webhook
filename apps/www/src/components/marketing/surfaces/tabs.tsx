"use client";

import { cn } from "@webhook-co/ui";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { focusRing } from "@/lib/styles";

export interface TabItem {
  /** Stable id used to wire the tab to its panel. */
  id: string;
  label: string;
  icon?: ReactNode;
  panel: ReactNode;
}

/**
 * A keyboard-accessible tablist following the WAI-ARIA APG tabs pattern: roving tabindex (the
 * selected tab is the only one in the tab order), arrow keys + Home/End move selection *and* focus,
 * and inactive panels carry the `hidden` attribute. Copy-free — callers pass `items`.
 */
export function Tabs({
  items,
  defaultId,
  idBase,
  "aria-label": ariaLabel,
}: {
  items: readonly TabItem[];
  defaultId?: string;
  /** Namespace for the generated tab/panel ids (must be unique per tablist on the page). */
  idBase: string;
  "aria-label": string;
}) {
  const [selected, setSelected] = useState(defaultId ?? items[0]?.id);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = items.findIndex((item) => item.id === selected);
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % items.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = items[next];
    if (!target) return;
    setSelected(target.id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex flex-wrap gap-1.5"
      >
        {items.map((item, index) => {
          const isSelected = item.id === selected;
          return (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${idBase}-${item.id}`}
              aria-selected={isSelected}
              aria-controls={`${idBase}-panel-${item.id}`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setSelected(item.id)}
              className={cn(
                focusRing,
                "inline-flex items-center gap-2 rounded-control px-3.5 py-2 text-sm font-medium transition-colors",
                isSelected
                  ? "bg-surface-inverse text-fg-on-inverse"
                  : "border border-hairline bg-surface text-fg-secondary hover:bg-surface-sunken hover:text-fg",
              )}
            >
              {item.icon ? (
                <span aria-hidden="true" className="inline-flex">
                  {item.icon}
                </span>
              ) : null}
              {item.label}
            </button>
          );
        })}
      </div>

      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${idBase}-panel-${item.id}`}
          aria-labelledby={`${idBase}-${item.id}`}
          tabIndex={0}
          hidden={item.id !== selected}
          className={cn(focusRing, "mt-4 rounded-card")}
        >
          {item.panel}
        </div>
      ))}
    </div>
  );
}
