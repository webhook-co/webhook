// Format timestamps deterministically — a FIXED locale ("en-US") + FIXED time zone ("UTC") — so the
// workerd SSR pass and the browser hydration pass render the IDENTICAL string. Using the runtime default
// locale/zone (`toLocaleString(undefined, …)` with no `timeZone`) differs between the server (UTC workerd)
// and the user's browser, which trips a React hydration mismatch and visibly flips the timestamp on load.
// The dashboard shows UTC (labeled on the time) — stable across server/client and unambiguous for a
// developer surface. Shared by the endpoint list + detail so the two can't drift.
//
// The Intl.DateTimeFormat instances are built ONCE at module load (the expensive part of toLocale*String)
// and reused — the list renders up to 100 rows per pass, so per-call construction would be wasted CPU.

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const DATETIME_FMT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export function formatDate(d: Date): string {
  return DATE_FMT.format(new Date(d));
}

export function formatDateTime(d: Date): string {
  return DATETIME_FMT.format(new Date(d));
}
