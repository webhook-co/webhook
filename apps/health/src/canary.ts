import type { Check, HealthStatus } from "@webhook-co/shared/health";

/**
 * The end-to-end delivery canary.
 *
 * "Event Delivery" is the product, and it is the one component with no endpoint to probe: the
 * pipeline is asynchronous, so nothing about it can be observed by asking a URL whether it is up.
 *
 * The canary closes that gap by performing a real transaction on a fixed schedule — POST a signed
 * synthetic event to a live ingest URL, let it flow through capture, matching and delivery, and
 * catch it coming back out at a sink. The result is then exposed as an ordinary HTTP endpoint that
 * returns 503 once the last success goes stale.
 *
 * That inversion is what makes this vendor-neutral. A dead-man's switch normally requires a monitor
 * that accepts *pushes*; by publishing freshness as something pollable, the same signal works with
 * any monitoring product, including ones that only support HTTP GET.
 *
 * CORRELATION IS DEFERRED BY ONE TICK. A tick sends a nonce and checks the PREVIOUS one, rather than
 * sending and waiting. Waiting inline would mean either a long-held Worker invocation or a timeout
 * short enough to report a slow-but-working pipeline as broken; deferring gives the pipeline a full
 * interval to complete and keeps every tick cheap.
 */

/** What a tick records about the round-trip. */
export interface CanaryState {
  /** The nonce sent by the most recent tick, awaiting correlation on the next one. */
  readonly inFlight: { readonly nonce: string; readonly sentAt: number } | null;
  /** When a round-trip last completed successfully. `null` until the first one does. */
  readonly lastSuccessAt: number | null;
  /** How long that last successful round-trip took, for operator visibility. */
  readonly lastLatencyMs: number | null;
}

export const EMPTY_STATE: CanaryState = {
  inFlight: null,
  lastSuccessAt: null,
  lastLatencyMs: null,
};

export const KV_STATE_KEY = "canary:state";
export const receiptKey = (nonce: string) => `canary:receipt:${nonce}`;

/**
 * How long the last success may age before delivery is reported broken.
 *
 * Three intervals at a 5-minute tick. One missed round-trip is a blip — a delivery retry, a slow
 * cold start — and reporting an outage on it would train everyone to ignore the page. Three
 * consecutive misses is a pipeline that has stopped.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** Parse persisted state, treating anything malformed as "no history" rather than throwing. */
export function parseState(raw: string | null): CanaryState {
  if (raw === null) return EMPTY_STATE;
  try {
    const p: unknown = JSON.parse(raw);
    if (typeof p !== "object" || p === null) return EMPTY_STATE;
    const { inFlight, lastSuccessAt, lastLatencyMs } = p as Record<string, unknown>;

    let flight: CanaryState["inFlight"] = null;
    if (typeof inFlight === "object" && inFlight !== null) {
      const { nonce, sentAt } = inFlight as Record<string, unknown>;
      if (typeof nonce === "string" && nonce.length > 0 && typeof sentAt === "number") {
        flight = { nonce, sentAt };
      }
    }
    return {
      inFlight: flight,
      lastSuccessAt: typeof lastSuccessAt === "number" ? lastSuccessAt : null,
      lastLatencyMs: typeof lastLatencyMs === "number" ? lastLatencyMs : null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * Grade delivery from the last successful round-trip.
 *
 * Never having completed one is `fail`, for the same reason a missing heartbeat is: at that point
 * there is no evidence the pipeline works, and "no evidence" must not render as healthy.
 */
export function deliveryStatus(
  state: CanaryState,
  now: number,
  staleAfterMs: number = STALE_AFTER_MS,
): HealthStatus {
  if (state.lastSuccessAt === null) return "fail";
  return now - state.lastSuccessAt > staleAfterMs ? "fail" : "pass";
}

/** The single check behind the public `/component/delivery` endpoint. */
export function deliveryChecks(
  read: () => Promise<CanaryState>,
  now: () => number = Date.now,
  staleAfterMs: number = STALE_AFTER_MS,
): Record<string, Check> {
  return {
    delivery: async () => deliveryStatus(await read(), now(), staleAfterMs),
  };
}

/**
 * Fold one tick's observations into the next state.
 *
 * Pure, so the interesting part — what counts as success, and what happens when a round-trip is
 * missed — is testable without KV, a network, or a clock.
 *
 * A missed correlation deliberately does NOT clear `lastSuccessAt`. Staleness alone decides health,
 * so a single miss degrades gracefully toward the threshold instead of flipping the component red
 * the instant one event is slow.
 */
export function advance(
  prev: CanaryState,
  observed: { receiptAt: number | null; newNonce: string; now: number },
): CanaryState {
  const { receiptAt, newNonce, now } = observed;
  const correlated = prev.inFlight !== null && receiptAt !== null;

  return {
    inFlight: { nonce: newNonce, sentAt: now },
    lastSuccessAt: correlated ? receiptAt : prev.lastSuccessAt,
    lastLatencyMs:
      correlated && prev.inFlight !== null
        ? Math.max(0, receiptAt - prev.inFlight.sentAt)
        : prev.lastLatencyMs,
  };
}
