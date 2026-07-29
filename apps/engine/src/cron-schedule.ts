// The engine's cron expressions.
//
// These live OUTSIDE src/index.ts, and that placement is load-bearing rather than tidiness. workerd treats
// every NAMED EXPORT of a Worker's entry module as a potential entrypoint, and rejects one that is not a
// function or an ExportedHandler:
//
//   service core:user:webhook-engine: Uncaught TypeError: Incorrect type for map entry
//   'CAP_PRODUCER_CRON': the provided value is not of type 'function or ExportedHandler'.
//
// Exporting these two STRINGS from the entry module therefore made `wrangler dev` refuse to start the
// engine at all — the one app an ingest URL has to reach. Deploy was unaffected, so it stayed invisible
// until something actually tried to run the worker locally.
//
// Keep non-handler values out of the entry module. Functions and classes are fine; plain data is not.

/** The dedicated frequent trigger for the soft-cap producer (S4). Must match a `triggers.crons` entry in
 *  apps/engine/wrangler.jsonc — enforced by scripts/cap-cron-sync-guard.mjs — or the fast pause path is
 *  silently lost and only the hourly backstop enforces the cap (pause latency regresses to ~1h). */
export const CAP_PRODUCER_CRON = "*/5 * * * *";

/** The hourly trigger for the heavy crons (rollup/reconcilers/reporters/purges). Also a `triggers.crons`
 *  entry in apps/engine/wrangler.jsonc; the sync guard asserts wrangler holds EXACTLY these two crons so an
 *  added/renamed trigger can't silently run the heavy jobs on an unexpected cadence. */
export const HOURLY_CRON = "0 * * * *";
