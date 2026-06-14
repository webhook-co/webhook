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
