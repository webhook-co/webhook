"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { DateRangeFilter } from "@/components/date-range-filter";

// The /dashboard window control — the same date-range picker the events list uses (presets + calendar),
// driven entirely by the URL query so the view is shareable, bookmarkable, and refresh-safe. It only owns the
// range/from/to params; the server page re-reads them, resolves the window (resolveDashboardWindow), and
// re-runs the load. `replace` (not `push`) so flipping the window doesn't pile up history entries.
export function DashboardDateFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const value = {
    range: searchParams.get("range") ?? "",
    from: searchParams.get("from") ?? "",
    to: searchParams.get("to") ?? "",
  };

  function onApply(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, val] of Object.entries(patch)) {
      if (val) next.set(key, val);
      else next.delete(key);
    }
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return <DateRangeFilter value={value} onApply={onApply} />;
}
