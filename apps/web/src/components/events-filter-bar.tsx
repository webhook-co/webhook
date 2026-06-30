"use client";

import {
  Button,
  Input,
  MultiSelect,
  type MultiSelectOption,
  ProviderLogo,
  providerDisplayName,
} from "@webhook-co/ui";
import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { DateRangeFilter } from "@/components/date-range-filter";
import { VERIFICATION_STATE_LABELS, VERIFICATION_STATES } from "@/lib/verification-state";

// The events-list filter bar, driven entirely by the URL query so the filtered view is shareable,
// bookmarkable, and refresh-safe. Two tiers encode two jobs: a full-width SEARCH row (find one event by
// id) sits apart from the faceting row below — provider, verification, and a date-range control
// (`?provider=&status=&range|from|to=&search=`). The selects/date push on change; the search debounces
// (it's free typing). The server page re-reads the query, re-runs the filtered load, and re-keys the
// list. No client-side filtering — the DB does it.

const FILTER_KEYS = ["provider", "status", "from", "to", "search", "range"] as const;
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

  // provider + status are MULTI-select (repeated params). An optimistic override reflects a just-pushed
  // selection BEFORE the RSC navigation commits, so rapid multi-toggling (faster than the round-trip)
  // computes each toggle against the live selection instead of a stale committed URL (which would drop
  // earlier picks). Cleared once the URL commits. The displayed selection is also filtered to the known
  // vocabulary, so a hand-edited invalid `?provider=`/`?status=` member isn't counted as active.
  const [pendingSel, setPendingSel] = React.useState<{
    provider?: string[];
    status?: string[];
  }>({});
  const providerSel = (pendingSel.provider ?? searchParams.getAll("provider")).filter((p) =>
    providers.includes(p),
  );
  const statusSel = (pendingSel.status ?? searchParams.getAll("status")).filter((s) =>
    (VERIFICATION_STATES as readonly string[]).includes(s),
  );
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const search = searchParams.get("search") ?? "";
  const range = searchParams.get("range") ?? "";
  const active =
    providerSel.length > 0 ||
    statusSel.length > 0 ||
    from !== "" ||
    to !== "" ||
    search !== "" ||
    range !== "";

  const providerOptions = React.useMemo<MultiSelectOption[]>(
    () =>
      providers.map((p) => ({
        value: p,
        label: providerDisplayName(p),
        icon: <ProviderLogo slug={p} size={16} />,
      })),
    [providers],
  );
  const statusOptions = React.useMemo<MultiSelectOption[]>(
    () => VERIFICATION_STATES.map((s) => ({ value: s, label: VERIFICATION_STATE_LABELS[s] })),
    [],
  );

  // The query string WE last pushed. Changing two controls within the RSC-navigation commit window
  // would otherwise both start from the stale `searchParams` snapshot and clobber each other; merging
  // against the last-pushed value keeps every change. Reset once the URL actually commits.
  const lastPushedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    lastPushedRef.current = null;
    setPendingSel({});
  }, [committedQuery]);

  function apply(next: URLSearchParams) {
    const qs = next.toString();
    lastPushedRef.current = qs;
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Apply a patch of one or more keys in a single merge against the last-pushed value (so concurrent
  // control changes aren't split or clobbered). The date control sets a preset + clears from/to (or vice
  // versa) in one push; the selects set a single key.
  function applyPatch(patch: Record<string, string>) {
    const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    apply(next);
  }

  // Set a multi-value key to the given list (repeated params), merged against the last-pushed value so a
  // concurrent single-key change isn't clobbered. An empty list deletes the key (no filter).
  function setMulti(key: "provider" | "status", values: readonly string[]) {
    setPendingSel((prev) => ({ ...prev, [key]: [...values] }));
    const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
    next.delete(key);
    for (const value of values) next.append(key, value);
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
    // Wipe every filter — including the search box. Reset the search input + pending flag so an in-flight
    // debounce (if the user typed then hit Clear within the window) no-ops instead of re-pushing the
    // just-cleared term.
    setSearchInput("");
    searchPendingRef.current = false;
    const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
    for (const key of FILTER_KEYS) next.delete(key);
    apply(next);
  }

  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface-sunken p-4">
      {/* Tier 1 — find: a full-width search, set apart from the faceting controls below. */}
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
        />
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
          placeholder="Search by event id, external id, provider event id, or header"
          aria-label="Search events"
          className="pl-9"
        />
      </div>

      {/* Tier 2 — narrow: the faceting controls, with Clear right-aligned (disabled when nothing's set). */}
      <div className="flex flex-wrap items-center gap-2">
        <MultiSelect
          label="Filter by provider"
          placeholder="All providers"
          options={providerOptions}
          selected={providerSel}
          onChange={(values) => setMulti("provider", values)}
          searchable
          searchPlaceholder="Search providers…"
          className="w-44"
        />

        <MultiSelect
          label="Filter by verification status"
          placeholder="All statuses"
          options={statusOptions}
          selected={statusSel}
          onChange={(values) => setMulti("status", values)}
          className="w-40"
        />

        <DateRangeFilter value={{ range, from, to }} onApply={applyPatch} />

        <Button variant="secondary" onClick={clear} disabled={!active} className="ml-auto">
          Clear filters
        </Button>
      </div>
    </div>
  );
}
