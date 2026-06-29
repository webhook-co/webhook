"use client";

import { Input } from "@webhook-co/ui";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import * as React from "react";

// A debounced, URL-driven name filter for the endpoints list (`?name=`). Typing updates local state
// immediately (smooth input) and pushes to the URL after a short pause; the server page re-reads the
// query, re-runs the filtered load, and re-syncs the manager. Kept SEPARATE from the manager so this
// input keeps focus across the re-render.

const DEBOUNCE_MS = 300;

export function EndpointsSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlName = searchParams.get("name") ?? "";
  const [value, setValue] = React.useState(urlName);
  // The last `name` value WE pushed. Used to tell our own URL change (don't disturb the input) from an
  // EXTERNAL one (back/forward, a clear link) that should re-sync the input.
  const lastPushedRef = React.useRef<string | null>(null);

  // Adopt an external ?name change into the input; skip our own pushes so in-progress typing isn't clobbered.
  React.useEffect(() => {
    if (urlName !== lastPushedRef.current) setValue(urlName);
  }, [urlName]);

  // Debounce the URL update so typing stays smooth and we don't re-query on every keystroke.
  React.useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = value.trim();
      // Skip a redundant replace (e.g. the value already matches the URL) so a no-op doesn't churn history.
      if (trimmed === urlName) return;
      const next = new URLSearchParams(searchParams.toString());
      if (trimmed) next.set("name", trimmed);
      else next.delete("name");
      lastPushedRef.current = trimmed;
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [value, urlName, pathname, router, searchParams]);

  return (
    <Input
      type="search"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Search endpoints by name"
      aria-label="Search endpoints by name"
      className="max-w-sm"
    />
  );
}
