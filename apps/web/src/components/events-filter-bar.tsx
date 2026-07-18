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
import {
  EVENT_TYPE_MAX_LENGTH,
  effectiveEventType,
  effectiveHeaderSearch,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  searchTooShort,
} from "@/lib/event-filters";
import { DEDUP_STRATEGIES, DEDUP_STRATEGY_LABELS, HTTP_METHODS } from "@/lib/event-facets";
import { VERIFICATION_STATE_LABELS, VERIFICATION_STATES } from "@/lib/verification-state";

// The events-list filter bar, driven entirely by the URL query so the filtered view is shareable,
// bookmarkable, and refresh-safe. Two tiers encode two jobs: a full-width SEARCH row (find one event by
// id) sits apart from the faceting row below — provider, verification, and a date-range control
// (`?provider=&status=&range|from|to=&search=`). The selects/date push on change; the search debounces
// (it's free typing). The server page re-reads the query, re-runs the filtered load, and re-keys the
// list. No client-side filtering — the DB does it.

// `endpointId` is listed unconditionally: Clear deleting a param the per-endpoint page never sets is a no-op.
const FILTER_KEYS = [
  "provider",
  "status",
  "from",
  "to",
  "search",
  "headerSearch",
  "range",
  "endpointId",
  "method",
  "dedupStrategy",
  "eventType",
] as const;
/** Exported so tests wait on the REAL window rather than a duplicated guess that could drift from it. */
export const SEARCH_DEBOUNCE_MS = 300;

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

/**
 * A screen-reader-stable hint under a free-text filter. ALWAYS MOUNTED as a `role="status"` live region that
 * toggles its TEXT — never conditionally rendered. A status node inserted into the DOM at announce time is
 * unreliable: several screen readers only announce changes to regions they were already observing, so a
 * mount-on-demand hint can stay silent. Kept as one component so the search hint and the event-type coverage
 * hint can't drift (they already had — one carried the live-region attributes, the other didn't).
 *
 * `active` both reveals the text visually and gates whether the linked input should point at it via
 * aria-describedby (do that at the call site, matching `active`), so an empty box isn't described by a caveat.
 */
function FilterHint({
  id,
  active,
  children,
}: {
  id: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <p
      id={id}
      role="status"
      aria-live="polite"
      className={active ? "mt-1.5 text-sm text-fg-muted" : "sr-only"}
    >
      {active ? children : ""}
    </p>
  );
}

/** The state + methods a {@link useCommitOnBlurFilter} box exposes to its `<Input>` and to Clear. */
interface CommitOnBlurFilter {
  /** The current box text (optimistic — may be ahead of the URL between a commit and its RSC round trip). */
  readonly value: string;
  /** onChange handler backing — updates the box text without navigating. */
  readonly setValue: (value: string) => void;
  /** Commit on Enter/blur: normalize to what the parser would apply, then push it (a no-op if unchanged). */
  readonly commit: () => void;
  /** Clear's reset — empties the box AND its committed ref (typed-but-uncommitted text has no URL to sync from). */
  readonly reset: () => void;
}

/**
 * A free-text filter box that commits on Enter/blur — NOT debounced-as-you-type like the search box. Used by
 * BOTH the eventType facet (an exact match — `charge` never equals `charge.succeeded`, so a partial push is
 * wrong) and the headerSearch facet (#24 — each scan is a SLOW unindexed header read, so it must not fire on
 * every keystroke). Extracted so the two can't drift: the discipline below is load-bearing and was hard-won.
 *
 * The URL-sync strategy is DELIBERATELY different from the search box's (which self-heals via its always-running
 * debounce timer, an equivalent this box has none of). We compare the incoming URL value against what WE last
 * pushed (`committedRef`) to tell our own commit's lagging echo apart from a genuine external navigation:
 *  - adopt the URL value into the box ONLY when it DIFFERS from committedRef — an EXTERNAL change (back/forward,
 *    Clear, a shared link), so the box must reflect where the reader landed;
 *  - when it EQUALS committedRef it's merely our own commit's navigation catching up, and the box may hold
 *    characters typed during that round trip — adopting would clobber them.
 * This one comparison replaces a "pending" latch that (unlike search's timer-reset one) never self-healed: a
 * stuck latch left the box stale over freshly-navigated data and re-pushed the stale value on the next blur.
 *
 * `toEffective` is the SAME predicate the URL parser uses, so only a value the server would actually apply
 * reaches the URL — a whitespace-only / over-long term collapses to "" (no filter), keeping the box, the URL,
 * Clear, and the hint in agreement (never lighting the filter UI over an unfiltered list). `push` receives that
 * effective value and writes it through the shared applyPatch.
 */
function useCommitOnBlurFilter(
  urlValue: string,
  toEffective: (raw: string | null | undefined) => string,
  push: (effective: string) => void,
): CommitOnBlurFilter {
  const [value, setValue] = React.useState(urlValue);
  // What we last PUSHED (kept current as the URL commits). Two jobs: (1) makes commit idempotent — the URL lags
  // a commit by one RSC round trip, so Enter-then-blur would otherwise re-push the same value; and (2)
  // discriminates, in the effect below, our own commit's echo from an external change.
  const committedRef = React.useRef(urlValue);
  React.useEffect(() => {
    if (urlValue !== committedRef.current) setValue(urlValue);
    committedRef.current = urlValue;
  }, [urlValue]);
  function commit() {
    const effective = toEffective(value);
    // Normalize the displayed value even on a no-op commit, so trailing whitespace / an over-long paste doesn't
    // linger in the box after blur.
    setValue(effective);
    if (effective === committedRef.current) return;
    committedRef.current = effective;
    push(effective);
  }
  function reset() {
    setValue("");
    committedRef.current = "";
  }
  return { value, setValue, commit, reset };
}

export function EventsFilterBar({ providers, endpoints, defaultRange }: EventsFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const committedQuery = searchParams.toString();

  // ONE optimistic snapshot of the query. `lastPushedRef` is the query string we last pushed; it is the merge
  // base for the next write AND the source every control reads for display (viewParams), so a single click
  // updates the whole bar on the SAME render, uniformly — no control jumps ahead while another lags the RSC
  // round trip. Rapid multi-toggling merges against this live snapshot, so no earlier pick is dropped.
  const lastPushedRef = React.useRef<string | null>(null);
  // The committed query AT THE MOMENT of that push. The instant the committed URL moves off it — whether our
  // push landed OR the reader hit Back/forward — the snapshot is spent, so we drop it HERE, during render
  // (React's sanctioned "adjust during render"), not in an effect. Consequences: viewParams never renders from
  // a stale snapshot (no post-commit flash); a NO-OP push — which never changes committedQuery, so never fires
  // an effect — can't strand it; and it's UNCONDITIONAL, so an external nav is adopted at once. The lone cost
  // is a 1-frame flicker when a SECOND push is in flight as the first commits (e.g. a facet clicked within
  // Clear's round trip) — cosmetic, self-healing, and cheaper than tracking per-push causality would be.
  const committedAtPushRef = React.useRef(committedQuery);
  if (committedQuery !== committedAtPushRef.current) {
    committedAtPushRef.current = committedQuery;
    lastPushedRef.current = null;
  }
  // A push mutates lastPushedRef (a ref → no re-render on its own); bump so the optimistic value shows at once.
  const [, bumpView] = React.useReducer((n: number) => n + 1, 0);
  const viewParams = new URLSearchParams(lastPushedRef.current ?? committedQuery);

  // provider/status/method/dedupStrategy are MULTI-select (repeated params). Each displayed selection is
  // filtered to the KNOWN vocabulary, so a hand-edited invalid member is neither shown nor counted as active.
  const providerSel = viewParams.getAll("provider").filter((p) => providers.includes(p));
  const statusSel = viewParams
    .getAll("status")
    .filter((s) => (VERIFICATION_STATES as readonly string[]).includes(s));
  const methodSel = viewParams
    .getAll("method")
    .filter((m) => (HTTP_METHODS as readonly string[]).includes(m));
  const dedupSel = viewParams
    .getAll("dedupStrategy")
    .filter((d) => (DEDUP_STRATEGIES as readonly string[]).includes(d));
  // The EFFECTIVE event type — what the server will actually filter on — not the raw `?eventType=`. Keying the
  // box, `active`/Clear, and the coverage hint off this (the same predicate the parser uses) means a shared
  // link with a whitespace-only or over-long value can't light the filter UI over an unfiltered list.
  const eventType = effectiveEventType(viewParams.get("eventType"));
  // The EFFECTIVE header search — what the server will actually filter on — keyed off the same predicate the
  // parser uses, so a shared link with a whitespace-only / over-long value can't light the filter UI over an
  // unfiltered list (the same chip-vs-data discipline as eventType).
  const headerSearch = effectiveHeaderSearch(viewParams.get("headerSearch"));
  const from = viewParams.get("from") ?? "";
  const to = viewParams.get("to") ?? "";
  const search = viewParams.get("search") ?? "";
  // RAW (what the URL says) vs EFFECTIVE (what the page applied). They differ exactly when the URL names no
  // date choice and the page falls back — the case the chip used to mislabel.
  const rawRange = viewParams.get("range") ?? "";
  // Read GUARDED: without the `endpoints &&`, a hand-added ?endpointId= on the per-endpoint page (which has
  // no such control) would enable Clear with nothing visibly set.
  const endpointSel = endpoints ? (viewParams.get("endpointId") ?? "") : "";
  const range = effectiveDateRange({ range: rawRange, from, to }, defaultRange ?? "");
  const active =
    endpointSel !== "" ||
    providerSel.length > 0 ||
    statusSel.length > 0 ||
    methodSel.length > 0 ||
    dedupSel.length > 0 ||
    eventType !== "" ||
    headerSearch !== "" ||
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
  // method labels ARE the verbs (no mapping); dedup shows a human label, never the raw slug.
  const methodOptions = React.useMemo<MultiSelectOption[]>(
    () => HTTP_METHODS.map((m) => ({ value: m, label: m })),
    [],
  );
  const dedupOptions = React.useMemo<MultiSelectOption[]>(
    () => DEDUP_STRATEGIES.map((d) => ({ value: d, label: DEDUP_STRATEGY_LABELS[d] })),
    [],
  );

  // Record the URL we're pushing FROM (so adjust-during-render can tell when it has moved on), pin the pushed
  // query as the optimistic snapshot, and bump so it renders immediately. There is no reset effect: the
  // snapshot is cleared during render, above, the moment committedQuery changes.
  function apply(next: URLSearchParams) {
    const qs = next.toString();
    committedAtPushRef.current = committedQuery;
    lastPushedRef.current = qs;
    bumpView();
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
  function setMulti(
    key: "provider" | "status" | "method" | "dedupStrategy",
    values: readonly string[],
  ) {
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

  // eventType (exact match — `charge` never equals `charge.succeeded`) and headerSearch (#24 — a SLOW unindexed
  // header scan) both commit on Enter/blur rather than as-you-type. ONE shared hook carries the hard-won
  // URL-sync discipline so the two can't drift (see useCommitOnBlurFilter). Each pushes through the SAME
  // applyPatch as the other facets, under its own key.
  const eventTypeFilter = useCommitOnBlurFilter(eventType, effectiveEventType, (v) =>
    applyPatch({ eventType: v }),
  );
  const headerSearchFilter = useCommitOnBlurFilter(headerSearch, effectiveHeaderSearch, (v) =>
    applyPatch({ headerSearch: v }),
  );

  const searchPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!searchPendingRef.current) setSearchInput(search);
  }, [search]);
  React.useEffect(() => {
    const handle = setTimeout(() => {
      searchPendingRef.current = false;
      const trimmed = searchInput.trim();
      // Compare what would actually be APPLIED, not what was typed. A 1-2 char term applies as "no search"
      // (parseEventFilters drops it — pg_trgm extracts no trigrams below 3 chars), so typing "ab" with no
      // search active is a no-op and must not navigate at all. Comparing the raw input instead pushed an
      // IDENTICAL url: a wasted RSC round trip on every keystroke below the floor.
      const effective = trimmed.length >= SEARCH_MIN_LENGTH ? trimmed : "";
      if (effective === search) return;
      // Inlined (not the `apply` closure) so the deps stay stable — listing `apply` would reset the
      // debounce timer every render. Merge against the last-pushed value to keep concurrent control changes.
      const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
      // Only a term that can actually RUN reaches the URL. A 1-2 char term is dropped by parseEventFilters
      // (pg_trgm extracts no trigrams below 3 chars, so no index can serve it), so pushing it would put a
      // filter in the URL that is not applied: Clear lights up, the address bar is shareable, a round trip is
      // spent — and the list still shows every event in the org. The "keep typing" hint carries the state
      // instead. Deleting (not skipping) is deliberate: backspacing "abc" -> "ab" must REMOVE the applied
      // search, not strand it.
      if (effective) next.set("search", effective);
      else next.delete("search");
      const qs = next.toString();
      // Same push discipline as apply(): record where we pushed from + pin the snapshot + bump. Inlined
      // (rather than calling apply) so the effect's deps stay stable — listing apply would reset the debounce
      // timer every render. bumpView/setSearchInput/router identities are stable, so none belong in the deps.
      committedAtPushRef.current = committedQuery;
      lastPushedRef.current = qs;
      bumpView();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput, search, committedQuery, router, pathname]);

  function clear() {
    // Wipe every filter — including the free-text boxes. Reset the search input + pending flag so an in-flight
    // debounce (if the user typed then hit Clear within the window) no-ops instead of re-pushing the
    // just-cleared term; reset the event-type box + its committed ref too, since typed-but-uncommitted text
    // otherwise lingers (its URL value never changed, so the URL→input sync effect wouldn't fire).
    setSearchInput("");
    searchPendingRef.current = false;
    // Reset the commit-on-blur boxes + their committed refs too (typed-but-uncommitted text otherwise lingers,
    // since its URL value never changed so the URL→input sync effect wouldn't fire).
    eventTypeFilter.reset();
    headerSearchFilter.reset();
    const next = new URLSearchParams(lastPushedRef.current ?? committedQuery);
    for (const key of FILTER_KEYS) next.delete(key);
    // apply() pins this (empty) query as the snapshot and bumps, so viewParams reads empty on the next render:
    // every control — facets, endpoint, date, and Clear's own `active` flag — clears together, at once.
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
      <FilterHint id="events-search-hint" active={tooShort}>
        {`Keep typing — search needs at least ${SEARCH_MIN_LENGTH} characters.`}
      </FilterHint>

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

        <MultiSelect
          label="Filter by HTTP method"
          placeholder="All methods"
          options={methodOptions}
          selected={methodSel}
          onChange={(values) => setMulti("method", values)}
          className="w-36"
        />

        <MultiSelect
          label="Filter by dedup strategy"
          placeholder="All dedup"
          options={dedupOptions}
          selected={dedupSel}
          onChange={(values) => setMulti("dedupStrategy", values)}
          className="w-44"
        />

        {/* eventType is a free EXACT match, not a dropdown: the vocabulary is unbounded + user-controlled, so
            a `select distinct` per render would be the wrong shape. Commits on Enter/blur. The hint is honest
            about coverage — event type is only parsed for some providers, so a "no results" here can mean
            "we don't extract this provider's type", not "no such events". */}
        <Input
          value={eventTypeFilter.value}
          onChange={(e) => eventTypeFilter.setValue(e.target.value)}
          onBlur={eventTypeFilter.commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") eventTypeFilter.commit();
          }}
          placeholder="Event type (e.g. charge.succeeded)"
          aria-label="Filter by event type"
          // Only point at the hint while the filter is set — matching the search input. Otherwise a screen
          // reader announces the whole coverage caveat on every focus of an empty box, where it's noise.
          aria-describedby={eventType !== "" ? "events-eventtype-hint" : undefined}
          // The parser drops anything over this, so cap the box at the same bound: a value that can't be
          // applied can't be typed, and the silent-drop cliff can't be reached by hand.
          maxLength={EVENT_TYPE_MAX_LENGTH}
          className="w-56"
        />

        {/* headerSearch (#24) is a free substring over the RAW headers — a SEPARATE, deliberately-unindexed
            scan, so it commits on Enter/blur (NOT debounced-as-you-type like the search box above): each scan
            is expensive, so it must not fire on every keystroke. The hint is honest about the cost — it's
            slower than search, so pair it with a date range. */}
        <Input
          value={headerSearchFilter.value}
          onChange={(e) => headerSearchFilter.setValue(e.target.value)}
          onBlur={headerSearchFilter.commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") headerSearchFilter.commit();
          }}
          placeholder="Search headers (e.g. x-shopify-topic)"
          aria-label="Search request headers"
          aria-describedby={headerSearch !== "" ? "events-headersearch-hint" : undefined}
          maxLength={SEARCH_MAX_LENGTH}
          className="w-56"
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

      {/* Visible + announced only while an event-type filter is set. It exists because event type is NULL for
          providers whose payload we don't parse a type from, so an empty result is genuinely ambiguous — say
          so rather than let it read as "no such events". The input's aria-describedby is dropped in the same
          inactive state (above), so an empty box is never described by the caveat. */}
      <FilterHint id="events-eventtype-hint" active={eventType !== ""}>
        Event type is parsed for some providers only — no matches can mean we don’t extract this
        provider’s type, not that no events arrived.
      </FilterHint>

      {/* Visible + announced only while a header search is set. Header search runs an unindexed scan over the
          stored headers, so it's slower than the id/dedup-key search above — say so, nudge toward a date range,
          and be honest that it matches header names and values (not a full `name: value` line). */}
      <FilterHint id="events-headersearch-hint" active={headerSearch !== ""}>
        Matches a substring of request header names and values (not a full “name: value” line). This
        scan is slower than the search above — pair it with a date range to keep it fast.
      </FilterHint>
    </div>
  );
}
