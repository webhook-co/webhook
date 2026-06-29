"use client";

import { Button, Input, Label, Select } from "@webhook-co/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { VERIFICATION_STATE_LABELS, VERIFICATION_STATES } from "@/lib/verification-state";

// The events-list filter bar: provider + verification-state dropdowns + a received-at date range + a
// free-text search, driven entirely by the URL query (`?provider=&status=&from=&to=&search=`) so the
// filtered view is shareable, bookmarkable, and refresh-safe. The dropdowns/dates push on change; the
// search debounces (it's free typing). The server page re-reads the query, re-runs the filtered load, and
// re-keys the list. No client-side filtering — the DB does it.

const FILTER_KEYS = ["provider", "status", "from", "to", "search"] as const;
const SEARCH_DEBOUNCE_MS = 300;

export interface EventsFilterBarProps {
  /** The provider vocabulary (passed from the server so `@webhook-co/webhooks-spec` stays off the client). */
  readonly providers: readonly string[];
}

export function EventsFilterBar({ providers }: EventsFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const committedQuery = searchParams.toString();

  const provider = searchParams.get("provider") ?? "";
  const status = searchParams.get("status") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const search = searchParams.get("search") ?? "";
  const active = provider !== "" || status !== "" || from !== "" || to !== "" || search !== "";

  // The query string WE last pushed. Changing two controls within the RSC-navigation commit window
  // would otherwise both start from the stale `searchParams` snapshot and clobber each other; merging
  // against the last-pushed value keeps every change. Reset once the URL actually commits.
  const lastPushedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    lastPushedRef.current = null;
  }, [committedQuery]);

  function apply(next: URLSearchParams) {
    const qs = next.toString();
    lastPushedRef.current = qs;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function update(key: (typeof FILTER_KEYS)[number], value: string) {
    const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
    if (value) next.set(key, value);
    else next.delete(key);
    apply(next);
  }

  // The free-text search debounces (typing) and re-syncs from an external ?search change (back button).
  // `searchPending` is true while the input is "ahead" of the URL (a debounce in flight); it suppresses
  // the URL→input re-sync so neither our own pending push nor a mid-flight commit clobbers typing. When
  // NOT pending, any external ?search change is adopted — even one that round-trips back to a prior value
  // (the bug a "last-pushed value" ref had: it skipped the re-sync and left a filtered-but-blank box).
  const [searchInput, setSearchInput] = React.useState(search);
  const searchPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!searchPendingRef.current) setSearchInput(search);
  }, [search]);
  React.useEffect(() => {
    const handle = setTimeout(() => {
      searchPendingRef.current = false;
      const trimmed = searchInput.trim();
      if (trimmed === search) return;
      // Inlined (not the `apply` closure) so the deps stay stable — listing `apply` would reset the
      // debounce timer every render. Merge against the last-pushed value to keep concurrent control changes.
      const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
      if (trimmed) next.set("search", trimmed);
      else next.delete("search");
      const qs = next.toString();
      lastPushedRef.current = qs;
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput, search, committedQuery, router, pathname]);

  function clear() {
    // Wipe every filter — including the search box. Reset the input + the pending flag so an in-flight
    // search debounce (still scheduled if the user typed then hit Clear within the window) no-ops instead
    // of re-pushing the just-cleared term: with searchInput now "" the debounce sees trimmed === search.
    setSearchInput("");
    searchPendingRef.current = false;
    const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
    for (const key of FILTER_KEYS) next.delete(key);
    apply(next);
  }

  return (
    <div className="flex flex-wrap items-end gap-4 rounded-card border border-hairline bg-surface-sunken p-4">
      <div className="flex w-52 flex-col gap-1.5">
        <Label htmlFor="filter-provider">Provider</Label>
        <Select
          id="filter-provider"
          value={provider}
          onChange={(e) => update("provider", e.target.value)}
        >
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex w-44 flex-col gap-1.5">
        <Label htmlFor="filter-status">Verification</Label>
        <Select
          id="filter-status"
          value={status}
          onChange={(e) => update("status", e.target.value)}
        >
          <option value="">All</option>
          {VERIFICATION_STATES.map((s) => (
            <option key={s} value={s}>
              {VERIFICATION_STATE_LABELS[s]}
            </option>
          ))}
        </Select>
      </div>

      <div className="flex w-44 flex-col gap-1.5">
        <Label htmlFor="filter-from">From</Label>
        <Input
          id="filter-from"
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => update("from", e.target.value)}
        />
      </div>

      <div className="flex w-44 flex-col gap-1.5">
        <Label htmlFor="filter-to">To (exclusive)</Label>
        <Input
          id="filter-to"
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => update("to", e.target.value)}
        />
      </div>

      <div className="flex w-64 flex-col gap-1.5">
        <Label htmlFor="filter-search">Search</Label>
        <Input
          id="filter-search"
          type="search"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            // Mark the input "ahead" of the URL while it differs (debounce in flight) so a URL change
            // doesn't re-sync over the typing; the debounce clears it after pushing.
            searchPendingRef.current = e.target.value.trim() !== search;
          }}
          placeholder="event / provider / external id"
          aria-label="Search events by id"
        />
      </div>

      {active ? (
        <Button variant="secondary" onClick={clear}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
