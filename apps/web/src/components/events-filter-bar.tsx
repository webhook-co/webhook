"use client";

import { Button, Input, Label, Select } from "@webhook-co/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

import { VERIFICATION_STATE_LABELS, VERIFICATION_STATES } from "@/lib/verification-state";

// The events-list filter bar: provider + verification-state dropdowns + a received-at date range, driven
// entirely by the URL query (`?provider=&status=&from=&to=`) so the filtered view is shareable,
// bookmarkable, and refresh-safe. Each change does a `router.replace` (no history spam, no scroll jump);
// the server page re-reads the query, re-runs the filtered load, and re-keys the list. No client-side
// filtering — the DB does it.

const FILTER_KEYS = ["provider", "status", "from", "to"] as const;

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
  const active = provider !== "" || status !== "" || from !== "" || to !== "";

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

  function clear() {
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

      {active ? (
        <Button variant="secondary" onClick={clear}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
