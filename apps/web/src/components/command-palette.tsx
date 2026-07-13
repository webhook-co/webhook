"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import * as React from "react";

export interface CommandItem {
  readonly href: string;
  readonly label: string;
  /** Extra words that should match this item (e.g. "keys" finds Credentials). */
  readonly keywords?: readonly string[];
}

export interface CommandPaletteProps {
  readonly items: readonly CommandItem[];
}

/** Case-insensitive substring match over the label and its keywords. */
function matches(item: CommandItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (item.label.toLowerCase().includes(q)) return true;
  return (item.keywords ?? []).some((k) => k.toLowerCase().includes(q));
}

/**
 * ⌘K / Ctrl-K jump-to-page. Deliberately small: it navigates, it doesn't run commands. A palette that only
 * ever does the one thing it advertises beats one that half-does five.
 *
 * The shortcut is captured globally, but NOT while the user is typing into a field — hijacking ⌘K out of an
 * input is the kind of thing that makes a palette feel hostile.
 */
export function CommandPalette({ items }: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);

  const results = React.useMemo(() => items.filter((i) => matches(i, query)), [items, query]);

  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || el?.isContentEditable)
        return;
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // A stale highlight after filtering would navigate somewhere the user isn't looking at.
  React.useEffect(() => setActive(0), [query]);

  function go(item: CommandItem | undefined) {
    if (!item) return;
    setOpen(false);
    setQuery("");
    router.push(item.href);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Jump to</DialogTitle>
          <DialogDescription>Search for a page. Press Enter to go there.</DialogDescription>
        </DialogHeader>

        <Input
          autoFocus
          aria-label="Search pages"
          placeholder="Search pages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(results[active]);
            }
          }}
        />

        {results.length === 0 ? (
          <p className="text-sm text-fg-secondary">No pages match “{query}”.</p>
        ) : (
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {results.map((item, i) => (
              <li key={item.href}>
                <button
                  type="button"
                  // aria-current marks the keyboard-highlighted row so a screen reader follows the arrows.
                  aria-current={i === active ? "true" : undefined}
                  className={`flex w-full items-center rounded-control px-2.5 py-2 text-left text-sm text-fg-secondary hover:bg-surface-sunken hover:text-fg ${
                    i === active ? "bg-surface-sunken text-fg" : ""
                  }`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(item)}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
