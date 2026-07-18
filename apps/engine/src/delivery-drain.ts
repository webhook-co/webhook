// The PURE drain orchestration for the per-destination delivery DO (S3 Slice 3). Separated from the DO
// shell (delivery-do.ts) so the decision logic — FIFO order, the strict-ordered head-of-line gate, the
// fixed-exponential retry scheduling, and dead-lettering on exhaustion — is exhaustively unit-testable
// with fakes, independent of workerd / Postgres / R2 / KMS (each of which is covered in its own suite).
// runDeliveryDrain owns NO I/O: every read, the guarded POST, and every outcome write is an injected dep.

import {
  nextRetryDelayMs,
  type DeliverArgs,
  type DeliverResult,
  type MetricName,
  type SealedSigningSecret,
} from "@webhook-co/shared";
import type { DueDelivery } from "@webhook-co/db";

/** A drain outcome, for the correlation log + the delivery.attempts status_class. */
type DeliveryOutcome = "delivered" | "blocked" | "retry" | "dead" | "refused";

/** Bounded status_class for the delivery RED metrics — the HTTP class, or the non-HTTP outcome. */
function deliveryStatusClass(outcome: DeliveryOutcome, statusCode: number | null): string {
  if (outcome === "blocked") return "blocked"; // SSRF refusal
  if (outcome === "refused") return "refused"; // pre-delivery terminal (deleted source / verification reject)
  if (statusCode === null) return "error"; // network / timeout — no HTTP status
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  return "5xx";
}

/** Bounded attempt bucket (1 / 2 / 3 / 4-8) — never the raw unbounded count. */
function attemptBucket(attempt: number): string {
  return attempt <= 3 ? String(attempt) : "4-8";
}

export interface DrainDeps {
  /** The destination's due deliveries, FIFO (oldest first). */
  readonly listDue: () => Promise<readonly DueDelivery[]>;
  /** The destination's sealed signing secrets (relayed to the guarded deliver; empty ⇒ unsigned). */
  readonly signingSecrets: () => Promise<readonly SealedSigningSecret[]>;
  /** Whether the destination is in strict-FIFO mode. */
  readonly ordered: () => Promise<boolean>;
  /** Make ONE guarded, signed delivery attempt (the SSRF-guarded POST) and return the outcome. */
  readonly deliver: (
    d: DueDelivery,
    secrets: readonly SealedSigningSecret[],
  ) => Promise<DeliverResult>;
  /** Record a terminal success. */
  readonly recordDelivered: (
    d: DueDelivery,
    statusCode: number,
    durationMs: number,
  ) => Promise<void>;
  /** Record a retryable failure scheduled for `nextRetryAt` (the delivery stays owed). */
  readonly recordRetry: (
    d: DueDelivery,
    nextRetryAt: Date,
    statusCode: number | null,
    error: string | null,
    durationMs: number,
  ) => Promise<void>;
  /** Record a terminal dead-letter (retries exhausted). */
  readonly recordDead: (
    d: DueDelivery,
    statusCode: number | null,
    error: string | null,
    durationMs: number,
  ) => Promise<void>;
  /** Record a terminal block (a real SSRF refusal — not retried). */
  /** durationMs is null for a PRE-delivery refusal (no POST was made); the ms latency for a real SSRF block. */
  readonly recordBlocked: (
    d: DueDelivery,
    statusCode: number | null,
    error: string | null,
    durationMs: number | null,
  ) => Promise<void>;
  readonly now: () => number;
  /** 100% structured log per attempt, keyed by the event id — the received→delivered correlation (Slice 3.5). */
  readonly log: (event: string, fields: Record<string, unknown>) => void;
  /** Bounded RED-metric sink (Analytics Engine). Best-effort/optional; labels are bounded enums only. */
  readonly metric?: (name: MetricName, labels: Record<string, string>, value?: number) => void;
}

/**
 * Drain a destination's due deliveries. For each (in FIFO order): attempt the guarded POST, then record the
 * outcome — `delivered` (terminal), `blocked` (terminal — an SSRF refusal isn't retried), or `failed`
 * (retryable: schedule the next attempt via the fixed exponential schedule, or dead-letter once exhausted).
 * In strict-`ordered` mode a delivery that is RESCHEDULED for retry blocks the rest of this drain (its own
 * next_retry_at re-fires the alarm); a terminal head lets newer deliveries proceed. Best-effort never blocks.
 */
export async function runDeliveryDrain(deps: DrainDeps): Promise<void> {
  const [due, secrets, ordered] = await Promise.all([
    deps.listDue(),
    deps.signingSecrets(),
    deps.ordered(),
  ]);
  // 100% correlation log (keyed by eventId — received→delivered) + bounded RED metrics per attempt
  // (Slice 3.5). Best-effort: never gates a lifecycle write; labels are bounded enums (no id/URL).
  const observe = (
    d: DueDelivery,
    outcome: DeliveryOutcome,
    statusCode: number | null,
    durationMs: number | null,
  ): void => {
    deps.log("delivery.attempt", {
      eventId: d.eventId,
      deliveryId: d.id,
      attempt: d.attempt,
      outcome,
      statusCode,
      durationMs,
    });
    const sc = deliveryStatusClass(outcome, statusCode);
    deps.metric?.("delivery.attempts", {
      status_class: sc,
      attempt_bucket: attemptBucket(d.attempt),
    });
    if (durationMs !== null)
      deps.metric?.("delivery.duration_ms", { status_class: sc }, durationMs);
    if (outcome === "retry") deps.metric?.("delivery.retries", { status_class: sc });
  };
  for (const d of due) {
    // SECURITY GATE (S8-remainder Slice 3 / ADR-0103), defense in depth. A `failed`-verification event (a
    // signature WAS checked and REJECTED — forged/tampered) is never forwardable. The enqueue gate already
    // drops it, but the drain re-checks per delivery so a pre-gate/backlog row — or any future enqueue path
    // that forgets the gate — is terminally REFUSED here (never handed to the guarded POST), not delivered.
    // Terminal like an SSRF block: not retried, no auto-disable tally bump; a blocked head advances in
    // ordered mode. The signing gate (buildDeliverArgs) is a separate, narrower check on `verified`.
    if (!d.deliverable) {
      // Terminal refusal, but the CAUSE differs: a tombstoned source event (S3 — deleted by the user, body
      // redacted + purged) vs a verification rejection (a forged/tampered signature). Record the accurate
      // reason so a delivery view doesn't show a bogus "signature rejected" for an event the user deleted.
      await deps.recordBlocked(
        d,
        null,
        d.sourceDeleted
          ? "source event was deleted"
          : "verification failed: source signature was checked and rejected",
        null, // no POST was made, so there is no latency to record
      );
      observe(d, "refused", null, null);
      continue;
    }
    const result = await deps.deliver(d, secrets);
    if (result.outcome === "delivered") {
      await deps.recordDelivered(d, result.status ?? 0, result.latencyMs);
      observe(d, "delivered", result.status ?? 0, result.latencyMs);
      continue;
    }
    if (result.outcome === "blocked") {
      await deps.recordBlocked(d, result.status, result.error, result.latencyMs);
      observe(d, "blocked", result.status, result.latencyMs);
      continue;
    }
    // failed = retryable: schedule the next attempt, or dead-letter once the schedule is exhausted.
    const delay = nextRetryDelayMs(d.attempt);
    if (delay === null) {
      await deps.recordDead(d, result.status, result.error, result.latencyMs);
      observe(d, "dead", result.status, result.latencyMs);
      continue;
    }
    await deps.recordRetry(
      d,
      new Date(deps.now() + delay),
      result.status,
      result.error,
      result.latencyMs,
    );
    observe(d, "retry", result.status, result.latencyMs);
    if (ordered) break; // strict-FIFO: a retrying head blocks newer deliveries this drain
  }
}

/** The I/O the DO injects to build a real {@link DrainDeps}: the prefetched reads, the guarded deliver, and
 *  the three lifecycle writes (each taking the db-helper input shape, minus the tx). Kept narrow so the
 *  pure mapping below — which owns the load-bearing `attempt + 1` increment and the dead/blocked status
 *  selection — is unit-testable without workerd / Postgres. */
export interface DrainIo {
  readonly destinationId: string;
  readonly listDue: () => Promise<readonly DueDelivery[]>;
  readonly signingSecrets: () => Promise<readonly SealedSigningSecret[]>;
  readonly ordered: () => Promise<boolean>;
  readonly deliver: (
    d: DueDelivery,
    secrets: readonly SealedSigningSecret[],
  ) => Promise<DeliverResult>;
  readonly markDelivered: (a: {
    id: string;
    destinationId: string;
    attempt: number;
    statusCode: number;
    durationMs: number | null;
  }) => Promise<void>;
  readonly scheduleRetry: (a: {
    id: string;
    nextAttempt: number;
    nextRetryAt: Date;
    statusCode: number | null;
    error: string | null;
    durationMs: number | null;
  }) => Promise<void>;
  readonly markTerminal: (a: {
    id: string;
    destinationId: string;
    status: "dead" | "blocked";
    attempt: number;
    statusCode: number | null;
    error: string | null;
    durationMs: number | null;
  }) => Promise<void>;
  readonly now: () => number;
  /** Injected log sink (the DO wires console.log). */
  readonly log: (event: string, fields: Record<string, unknown>) => void;
  /** Injected bounded RED-metric sink (the DO wires emitMetric(env.METRICS)); optional/best-effort. */
  readonly metric?: (name: MetricName, labels: Record<string, string>, value?: number) => void;
}

/**
 * Build the {@link DrainDeps} the drain loop consumes from the DO's injected I/O. This is the PURE wiring
 * the DO shell used to inline: it maps each drain outcome to a lifecycle write — crucially advancing
 * `attempt` by exactly 1 on a retry (an off-by-one here would mean a delivery never exhausts the schedule,
 * so never dead-letters) and selecting `dead` (exhausted) vs `blocked` (SSRF refusal) — threading the
 * stable row id + the destination id through. Extracted so all of this is asserted in delivery-drain.test.ts.
 */
export function makeDrainDeps(io: DrainIo): DrainDeps {
  const { destinationId } = io;
  return {
    listDue: io.listDue,
    signingSecrets: io.signingSecrets,
    ordered: io.ordered,
    deliver: io.deliver,
    recordDelivered: (d, statusCode, durationMs) =>
      io.markDelivered({ id: d.id, destinationId, attempt: d.attempt, statusCode, durationMs }),
    recordRetry: (d, nextRetryAt, statusCode, error, durationMs) =>
      io.scheduleRetry({
        id: d.id,
        nextAttempt: d.attempt + 1,
        nextRetryAt,
        statusCode,
        error,
        durationMs,
      }),
    recordDead: (d, statusCode, error, durationMs) =>
      io.markTerminal({
        id: d.id,
        destinationId,
        status: "dead",
        attempt: d.attempt,
        statusCode,
        error,
        durationMs,
      }),
    recordBlocked: (d, statusCode, error, durationMs) =>
      io.markTerminal({
        id: d.id,
        destinationId,
        status: "blocked",
        attempt: d.attempt,
        statusCode,
        error,
        durationMs,
      }),
    now: io.now,
    log: io.log,
    metric: io.metric,
  };
}

/**
 * Build the guarded-deliver args for ONE attempt. The Standard Webhooks `webhook-id` is the STABLE delivery
 * row id across every retry (so a receiver dedups a re-sent delivery — the founder-locked invariant). The
 * delivery is signed ONLY when the destination has secrets AND the source event was VERIFIED
 * (S8-remainder Slice 3 / ADR-0103): we never re-sign — vouch for as webhook.co — an event we did not
 * authenticate, so an unverified (`unattempted`) event is delivered UNSIGNED even to a signing destination.
 * (`failed` events are dropped at enqueue AND terminally blocked in the drain — see runDeliveryDrain's
 * `deliverable` gate — so they never reach here.) Omitting the `signing` block is what gates the engine away
 * from KMS. `nowMs` yields the per-attempt timestamp.
 */
export function buildDeliverArgs(
  orgId: string,
  d: DueDelivery,
  secrets: readonly SealedSigningSecret[],
  nowMs: number,
): DeliverArgs {
  return {
    orgId,
    endpointId: d.endpointId,
    payloadR2Key: d.payloadR2Key,
    url: d.url,
    headers: d.headers,
    signing:
      d.verified && secrets.length > 0
        ? { webhookId: d.id, timestamp: Math.floor(nowMs / 1000), secrets }
        : undefined,
  };
}
