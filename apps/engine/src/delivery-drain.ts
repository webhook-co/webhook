// The PURE drain orchestration for the per-destination delivery DO (S3 Slice 3). Separated from the DO
// shell (delivery-do.ts) so the decision logic — FIFO order, the strict-ordered head-of-line gate, the
// fixed-exponential retry scheduling, and dead-lettering on exhaustion — is exhaustively unit-testable
// with fakes, independent of workerd / Postgres / R2 / KMS (each of which is covered in its own suite).
// runDeliveryDrain owns NO I/O: every read, the guarded POST, and every outcome write is an injected dep.

import {
  nextRetryDelayMs,
  type DeliverArgs,
  type DeliverResult,
  type SealedSigningSecret,
} from "@webhook-co/shared";
import type { DueDelivery } from "@webhook-co/db";

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
  readonly recordDelivered: (d: DueDelivery, statusCode: number) => Promise<void>;
  /** Record a retryable failure scheduled for `nextRetryAt` (the delivery stays owed). */
  readonly recordRetry: (
    d: DueDelivery,
    nextRetryAt: Date,
    statusCode: number | null,
    error: string | null,
  ) => Promise<void>;
  /** Record a terminal dead-letter (retries exhausted). */
  readonly recordDead: (
    d: DueDelivery,
    statusCode: number | null,
    error: string | null,
  ) => Promise<void>;
  /** Record a terminal block (a real SSRF refusal — not retried). */
  readonly recordBlocked: (
    d: DueDelivery,
    statusCode: number | null,
    error: string | null,
  ) => Promise<void>;
  readonly now: () => number;
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
  for (const d of due) {
    const result = await deps.deliver(d, secrets);
    if (result.outcome === "delivered") {
      await deps.recordDelivered(d, result.status ?? 0);
      continue;
    }
    if (result.outcome === "blocked") {
      await deps.recordBlocked(d, result.status, result.error);
      continue;
    }
    // failed = retryable: schedule the next attempt, or dead-letter once the schedule is exhausted.
    const delay = nextRetryDelayMs(d.attempt);
    if (delay === null) {
      await deps.recordDead(d, result.status, result.error);
      continue;
    }
    await deps.recordRetry(d, new Date(deps.now() + delay), result.status, result.error);
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
  }) => Promise<void>;
  readonly scheduleRetry: (a: {
    id: string;
    nextAttempt: number;
    nextRetryAt: Date;
    statusCode: number | null;
    error: string | null;
  }) => Promise<void>;
  readonly markTerminal: (a: {
    id: string;
    destinationId: string;
    status: "dead" | "blocked";
    attempt: number;
    statusCode: number | null;
    error: string | null;
  }) => Promise<void>;
  readonly now: () => number;
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
    recordDelivered: (d, statusCode) =>
      io.markDelivered({ id: d.id, destinationId, attempt: d.attempt, statusCode }),
    recordRetry: (d, nextRetryAt, statusCode, error) =>
      io.scheduleRetry({ id: d.id, nextAttempt: d.attempt + 1, nextRetryAt, statusCode, error }),
    recordDead: (d, statusCode, error) =>
      io.markTerminal({
        id: d.id,
        destinationId,
        status: "dead",
        attempt: d.attempt,
        statusCode,
        error,
      }),
    recordBlocked: (d, statusCode, error) =>
      io.markTerminal({
        id: d.id,
        destinationId,
        status: "blocked",
        attempt: d.attempt,
        statusCode,
        error,
      }),
    now: io.now,
  };
}

/**
 * Build the guarded-deliver args for ONE attempt. The Standard Webhooks `webhook-id` is the STABLE delivery
 * row id across every retry (so a receiver dedups a re-sent delivery — the founder-locked invariant), and the
 * delivery is signed ONLY when the destination has secrets (an unsigned destination must never construct a
 * `signing` block, which is what gates the engine away from KMS). `nowMs` yields the per-attempt timestamp.
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
    dedupKey: d.dedupKey,
    url: d.url,
    headers: d.headers,
    signing:
      secrets.length > 0
        ? { webhookId: d.id, timestamp: Math.floor(nowMs / 1000), secrets }
        : undefined,
  };
}
