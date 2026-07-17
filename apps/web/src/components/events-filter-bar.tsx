"use client";

import {
  Button,
  Combobox,
  type ComboboxOption,
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
import { effectiveDateRange } from "@/lib/date-range";
import { SEARCH_MIN_LENGTH, searchTooShort } from "@/lib/event-filters";
import { VERIFICATION_STATE_LABELS, VERIFICATION_STATES } from "@/lib/verification-state";

// The events-list filter bar, driven entirely by the URL query so the filtered view is shareable,
// bookmarkable, and refresh-safe. Two tiers encode two jobs: a full-width SEARCH row (find one event by
// id) sits apart from the faceting row below — provider, verification, and a date-range control
// (`?provider=&status=&range|from|to=&search=`). The selects/date push on change; the search debounces
// (it's free typing). The server page re-reads the query, re-runs the filtered load, and re-keys the
// list. No client-side filtering — the DB does it.

// `endpointId` is listed unconditionally: Clear deleting a param the per-endpoint page never sets is a no-op.
const FILTER_KEYS = ["provider", "status", "from", "to", "search", "range", "endpointId"] as const;
const SEARCH_DEBOUNCE_MS = 300;

export interface EventsFilterBarProps {
  /** The provider vocabulary (passed from the server so `@webhook-co/webhooks-spec` stays off the client). */
  readonly providers: readonly string[];
  /**
   * The org's endpoints, for the endpoint facet. OMIT to hide it — the per-endpoint page passes nothing and
   * renders exactly as it did before, since a control repeating the one endpoint it is already scoped to
   * would be noise.
   *
   * Includes soft-deleted endpoints: ADR-0076 keeps their events listable, so they are legitimate things to
   * filter BY — they are just labelled as deleted rather than presented as live.
   */
  readonly endpoints?: readonly {
    readonly id: string;
    readonly name: string;
    readonly deleted: boolean;
  }[];
  /**
   * The window the PAGE applies when the URL names none (the org browse defaults to 7d; the per-endpoint one
   * omits this and defaults to all time).
   *
   * The bar must be told, because it reads the URL and the default lives server-side — so without this the
   * chip read "Date range" while the reader was looking at 7 days of data. A default the UI does not name is
   * a silent filter. Resolution goes through effectiveDateRange, the same function the page uses, so the two
   * cannot drift apart again.
   */
  readonly defaultRange?: string;
}

export function EventsFilterBar({ providers, endpoints, defaultRange }: EventsFilterBarProps) {
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
  // RAW (what the URL says) vs EFFECTIVE (what the page applied). They differ exactly when the URL names no
  // date choice and the page falls back — the case the chip used to mislabel.
  const rawRange = searchParams.get("range") ?? "";
  // Read GUARDED: without the `endpoints &&`, a hand-added ?endpointId= on the per-endpoint page (which has
  // no such control) would enable Clear with nothing visibly set.
  const endpointSel = endpoints ? (searchParams.get("endpointId") ?? "") : "";
  const range = effectiveDateRange({ range: rawRange, from, to }, defaultRange ?? "");
  const active =
    endpointSel !== "" ||
    providerSel.length > 0 ||
    statusSel.length > 0 ||
    from !== "" ||
    to !== "" ||
    search !== "" ||
    // rawRange, NOT the effective one: the page's default is not a filter the reader SET, so it must not
    // light up Clear — and clearing it would only round-trip back to the same default anyway.
    rawRange !== "";

  // A single-select Combobox, NOT a MultiSelect like the facets beside it — deliberately. Two reasons:
  //   * SQL: `endpoint_id = $1` rides events_tunnel_idx (endpoint_id, received_at, id) with an equality seek
  //     and no Sort, so the org page filtered to one endpoint gets EXACTLY the per-endpoint page's plan.
  //     `endpoint_id = ANY($1)` is a ScalarArrayOpExpr on the leading column and does not preserve
  //     (received_at, id) ordering — it costs a Sort.
  //   * meaning: "which endpoint?" is a DRILL-DOWN, one answer. provider/status are closed vocabularies you
  //     genuinely want to union; an endpoint list is long, per-org, and searchable — which is what Combobox
  //     is for. It breaks the bar's multi-select idiom because the DATA is different in kind.
  // `value: ""` is the clear affordance.
  const endpointOptions = React.useMemo<ComboboxOption[]>(
    () => [
      { value: "", label: "All endpoints" },
      ...(endpoints ?? []).map((e) => ({
        value: e.id,
        // Never the raw uuid (the house rule), and a deleted endpoint says so rather than passing as live.
        label: e.deleted ? `${e.name} (deleted)` : e.name,
      })),
    ],
    [endpoints],
  );

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
  // Off the LIVE input, not the URL: the hint answers the reader as they type, before the debounce decides
  // (correctly) not to push a term that cannot run.
  const tooShort = searchTooShort({ search: searchInput });
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
          placeholder="Search by event id, provider event id, or dedup key"
          aria-label="Search events"
          aria-describedby={tooShort ? "events-search-hint" : undefined}
          className="pl-9"
        />
      </div>
      {/* A term below pg_trgm's 3-char floor cannot be run (no index can serve `%ab%`), and it used to be
          dropped in SILENCE — so the reader got the full unfiltered list back and had to guess that their
          search never happened. Say so instead. Reads off searchInput, not the URL: the point is to answer
          the reader WHILE they type, before the debounce would (not) push anything. */}
      {tooShort ? (
        <p id="events-search-hint" role="status" className="mt-1.5 text-sm text-fg-muted">
          Keep typing — search needs at least {SEARCH_MIN_LENGTH} characters.
        </p>
      ) : null}

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

        {endpoints ? (
          <Combobox
            label="Filter by endpoint"
            placeholder="All endpoints"
            options={endpointOptions}
            value={endpointSel}
            onChange={(value) => applyPatch({ endpointId: value })}
            searchPlaceholder="Search endpoints…"
            className="w-48"
          />
        ) : null}

        <DateRangeFilter
          value={{ range, from, to }}
          onApply={applyPatch}
          // Only where a default exists to escape FROM — and only the org browse bounds the resulting
          // unbounded query (browseEvents' statement_timeout). The per-endpoint bar passes no defaultRange
          // and is already all-time, so the option would be a no-op there.
          allowAllTime={defaultRange !== undefined}
        />

        <Button variant="secondary" onClick={clear} disabled={!active} className="ml-auto">
          Clear filters
        </Button>
      </div>
    </div>
  );
}
