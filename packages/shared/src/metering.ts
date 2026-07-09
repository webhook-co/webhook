// Soft-cap signal + rate-limit seam. Single-dimension (events). NO prices/tiers
// in this repo. Usage is rolled up from events (packages/db rollup_usage); the cap ->
// pause decision is computed by that job and written to ingest_paused; the ingest hot
// path only ever READS a cheap cached `paused` flag (on KV endpoint resolution), never
// a synchronous DB count.

/**
 * The per-org signal the ingest path reads from cache (KV) on endpoint resolution.
 * `paused` is the authoritative, pre-computed flag; `eventCap` is informational
 * (used by the metering job, surfaced to the dashboard). Reading this must never touch
 * Postgres on the hot path.
 */
export interface IngestGuardSignal {
  readonly orgId: string;
  readonly paused: boolean;
  /** numeric event cap, or null for uncapped. No price/tier — just the threshold. */
  readonly eventCap: number | null;
}

/** Whether the ingest path may accept an event for this org (cheap, cache-only). */
export function ingestAllowed(signal: IngestGuardSignal): boolean {
  return !signal.paused;
}

/**
 * The soft-cap decision the metering job applies (off the hot path): pause once usage
 * reaches the cap under a 'pause' policy. 'allow' never pauses (overage handled by the
 * separate, later billing system). Pure + deterministic so it's unit-testable and
 * identical wherever it runs.
 */
export function shouldPauseForCap(
  usage: number,
  eventCap: number | null,
  pausePolicy: "pause" | "allow",
): boolean {
  if (pausePolicy === "allow") return false;
  if (eventCap === null) return false;
  return usage >= eventCap;
}

/**
 * Parse the INJECTED Free-tier default event cap (the `FREE_EVENT_CAP` deploy var) into the cap the
 * producer applies to orgs with no explicit `org_limits` row. Since ADR-0004's 2026-07-09 amendment this
 * is a **ONE-TIME LIFETIME** allowance (every event the org has ever ingested), not a monthly quota — the
 * var name is unchanged but the basis is `capKind: "lifetime"`. This is a FAIL-SAFE gate: enforcement
 * turns on ONLY for a clean, strictly-positive integer. Everything else → null (uncapped, no Free
 * enforcement):
 *  - unset / blank → uncapped (the default posture; enabling Free-pause is a deliberate act).
 *  - `0` or negative → uncapped, NOT "cap at 0" — `shouldPauseForCap(usage, 0, 'pause')` is `usage >= 0`
 *    = always true, which would pause EVERY Free org. A fat-fingered `0` must never mass-pause the tier.
 *  - lenient/partial strings ("10k", "1e6", "1_000", "100abc") → uncapped, not their `parseInt` prefix.
 * Returning null for a set-but-invalid value lets the caller log it loudly (a silent mass-pause is the
 * worst outcome). Pure + deterministic so it is exhaustively unit-testable off the Worker.
 */
export function parseFreeEventCap(raw: string | undefined | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Strict: an optional sign is disallowed (we only accept positives) — digits only, no decimal, no
  // exponent, no separators, no unit suffix. Then bound to a safe integer.
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/**
 * The usage-threshold alert points (percent of the effective cap) — a WARN-BEFORE-PAUSE heads-up so an org
 * sees it approaching (and hitting) its cap before capture is ever paused. 80% = approaching, 100% = at the
 * cap (a 'pause' org is paused here). Ordered ascending. No prices — a percent of the org's own cap.
 */
export const USAGE_ALERT_THRESHOLDS = [80, 100] as const;

/**
 * The alert thresholds (percent) an org's period usage has reached, given its effective cap. Pure so the
 * producer's emit decision is deterministic + unit-tested. An UNCAPPED org (null or non-positive cap) has no
 * percentage → no thresholds (you can't be "80% of uncapped"). `Math.ceil` pins the exact event count each
 * threshold triggers at (e.g. cap 100 → 80% at 80 events, 100% at 100) so it matches the pause boundary
 * (shouldPauseForCap's `usage >= cap`). Returns ascending, so the caller emits at most one intent per point.
 */
export function crossedUsageThresholds(usage: number, eventCap: number | null): number[] {
  if (eventCap === null || eventCap <= 0) return [];
  return USAGE_ALERT_THRESHOLDS.filter((t) => usage >= Math.ceil((t / 100) * eventCap));
}

const DAY_MS = 86_400_000;

/** UTC midnight (ms) of the day containing `ms`. UTC has no DST, so day arithmetic by
 * whole DAY_MS steps from here is always exact — the metering day-bucket can't drift
 * with server timezone (the F4 alignment guarantee). */
function startOfUtcDayMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * The UTC-midnight day-windows a single rollup run must (re)count: today back through
 * `settleDays` prior days, oldest→newest, as ISO timestamps for `rollup_usage(window_start)`.
 * Re-rolling the just-closed day(s) is the fix for the pre-midnight tail (events that
 * commit between the last pre-midnight run and 00:00Z would otherwise never be counted).
 * A day drops out of this set only once it is older than `settleDays`, at which point the
 * caller finalizes it — so there is never a day that is open but no longer being rolled.
 */
export function rollupWindows(nowMs: number, settleDays: number): string[] {
  const startOfToday = startOfUtcDayMs(nowMs);
  const windows: string[] = [];
  for (let d = settleDays; d >= 0; d--) {
    windows.push(new Date(startOfToday - d * DAY_MS).toISOString());
  }
  return windows;
}

/**
 * The UTC-midnight boundary at/after which a `usage` day is still "open": any usage row
 * whose `window_start` is strictly older than this is finalized (frozen — its count is a
 * durable billing snapshot that is never recomputed again, so a later `events` deletion
 * can't make a billed count silently decrease). Equals the oldest window in
 * `rollupWindows(now, settleDays)`, so freezing only ever happens after recounting stops.
 */
export function finalizeCutoff(nowMs: number, settleDays: number): string {
  return new Date(startOfUtcDayMs(nowMs) - settleDays * DAY_MS).toISOString();
}

/** A billing period as half-open [start, end) UTC instants. */
export interface BillingPeriod {
  readonly start: string;
  readonly end: string;
}

/**
 * How an org's included-event allowance is scoped (ADR-0004, amended 2026-07-09):
 * - `lifetime` — the Free tier's ONE-TIME 5,000-event allowance. Counted over every event the org has
 *   ever ingested (since `orgs.created_at`) and it NEVER resets. Free is a trial, not a monthly tier.
 * - `billing_cycle` — a paid plan's per-cycle included volume, measured over the org's Stripe cycle.
 */
export type CapKind = "lifetime" | "billing_cycle";

/**
 * The period an org's cap is actually measured over. `end === null` means OPEN-ENDED — the one-time
 * lifetime allowance has no end, so every usage query must treat a null end as "no upper bound".
 */
export interface EffectivePeriod {
  readonly start: string;
  readonly end: string | null;
  readonly kind: CapKind;
}

/**
 * The org's current billing period. Until a Stripe subscription anchors it (S4.4), the default is the
 * UTC calendar month containing `now`, half-open [start, end) — Free/unsubscribed orgs stay on this
 * anchor. Pure so the usage surface and the cap→pause producer agree on exactly which window "this
 * period's usage" sums over.
 */
export function currentBillingPeriod(nowMs: number): BillingPeriod {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return {
    start: new Date(Date.UTC(y, m, 1)).toISOString(),
    // Date.UTC normalizes month 12 → January of the next year, so December rolls correctly.
    end: new Date(Date.UTC(y, m + 1, 1)).toISOString(),
  };
}

/**
 * The abuse rate-limit seam. The concrete implementations land on the ingest path:
 * Cloudflare Rate Limiting at the edge + a per-token Durable Object token-bucket. This
 * seam fixes the interface so the ingest path binds to it, not to a specific engine.
 */
export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Hint for a Retry-After response when not allowed. */
  readonly retryAfterMs?: number;
}

export interface RateLimiter {
  /** key is typically the ingest token hash (per-endpoint) or org id. */
  check(key: string): Promise<RateLimitDecision>;
}
