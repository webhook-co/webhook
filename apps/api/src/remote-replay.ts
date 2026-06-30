import { CapabilityFault, eventsReplay } from "@webhook-co/contract";
import {
  claimDeliveryAttempt,
  finalizeDeliveryAttempt,
  getActiveSigningSecrets,
  getEvent,
  getReplayDestination,
  serializeTarget,
  withTenant,
  type ReplayHandler,
  type Sql,
} from "@webhook-co/db";
import type { DeliverResult, DeliveryDispatcherRpc, DeliverySigning } from "@webhook-co/shared";

// The api-side orchestration for the REMOTE replay arm (events.replay with {kind:"destination"}, ADR-0081).
// The server delivers (unlike the localhost-tunnel arm, where the CLI POSTs and the api only records). This
// lives in apps/api — NOT packages/db — because it spans an external effect (the engine RPC) between two
// DB transactions; packages/db stays pure and exposes the granular helpers (resolve / claim / finalize)
// this composes. The outbound POST + the AUTHORITATIVE SSRF guard happen in the engine; api never fetches
// the destination itself.
//
// Flow: resolve event + endpoint + destination under RLS → CLAIM a 'pending' delivery_attempt [tx1,
// commits] → call the engine dispatcher [NO db tx held across the POST] → FINALIZE with the real outcome
// [tx2]. Idempotency: the caller mints a FRESH key per invocation (ADR-0016), so claim-first only dedups
// the api-client's transient same-key retries; a re-claim returns the existing row WITHOUT re-delivering.

export interface RemoteReplayDeps {
  /** webhook_app over the cache-disabled tenant binding — the RLS resolve + the claim/finalize run here. */
  readonly tenant: Sql;
  /** The engine's DeliveryDispatcher over the service binding — the only place the outbound POST happens. */
  readonly dispatcher: DeliveryDispatcherRpc;
}

export function createRemoteReplayHandler(deps: RemoteReplayDeps): ReplayHandler {
  return async (ctx, input) => {
    if (!ctx.scopes.includes(eventsReplay.auth.scope)) {
      throw new CapabilityFault("FORBIDDEN", `missing required scope: ${eventsReplay.auth.scope}`);
    }
    const parsed = eventsReplay.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    const { eventId, target, idempotencyKey } = parsed.data;
    if (target.kind !== "destination") {
      // This handler serves only the remote arm; the router routes localhost-tunnel elsewhere.
      throw new CapabilityFault("VALIDATION_ERROR", "not a remote destination target");
    }

    // tx1: resolve under RLS, then atomically claim the delivery row. NOTE: unlike the localhost arm we do
    // NOT resolve/inspect the inbound endpoint's paused state — replay to a SEPARATE registered destination
    // is independent of inbound ingestion (the event row already carries endpointId + dedupKey, and its FK
    // guarantees the endpoint exists; a soft-deleted endpoint's events stay replayable, ADR-0076).
    const claimed = await withTenant(deps.tenant, ctx.orgId, async (tx) => {
      const event = await getEvent(tx, eventId);
      if (!event) throw new CapabilityFault("NOT_FOUND", "event not found");
      const destination = await getReplayDestination(tx, target.destinationId);
      // NOT_FOUND (not a distinct code) so we don't leak whether the destination id exists cross-org.
      if (!destination) throw new CapabilityFault("NOT_FOUND", "replay destination not found");
      // The destination's active (+ retiring) signing secrets — SEALED; the api only ever relays
      // ciphertext, the engine alone unseals to sign (S3 Slice 2). Read in the same tenant tx as the
      // destination resolve. A destination with no secret (legacy/pre-Slice-2) yields [] → unsigned.
      const signingSecrets = await getActiveSigningSecrets(tx, destination.id);
      const { attempt, won } = await claimDeliveryAttempt(tx, {
        orgId: ctx.orgId,
        eventId,
        destinationId: destination.id,
        target: serializeTarget(target),
        idempotencyKey,
      });
      return { event, destinationUrl: destination.url, signingSecrets, attempt, won };
    });

    if (!claimed.won) {
      // The key was already claimed. It MUST identify THIS (event, destination) — a key reused for a
      // DIFFERENT replay would otherwise silently skip THIS delivery while returning the other request's
      // row as a false success. Reject the reuse; a MATCHING re-claim (a transient retry / concurrent
      // sibling) returns the existing row (terminal = idempotent; still 'pending' = in flight) — no re-POST.
      if (
        claimed.attempt.eventId !== eventId ||
        claimed.attempt.target !== serializeTarget(target)
      ) {
        throw new CapabilityFault(
          "VALIDATION_ERROR",
          "idempotency key already used for a different replay",
        );
      }
      return claimed.attempt;
    }

    // Deliver via the engine — the single guarded egress. No DB tx is held across the outbound POST (it
    // would pin a Hyperdrive connection for the whole RTT). The engine re-derives the R2 key from the
    // authenticated org/endpoint/dedup (H1) and runs the connect-time SSRF guard.
    //
    // If the RPC throws, the POST's outcome is UNKNOWN → record 'failed' (terminal, retryable) rather than
    // leaving the claim stuck 'pending'. Delivery is AT-LEAST-ONCE here: a fresh-key retry may re-send
    // (Standard Webhooks receivers dedup by webhook-id). Exactly-once + automatic reconciliation of an
    // in-doubt attempt is the delivery DO + DLQ (Slice 3/4); 1b is a deliberate one-shot replay.
    // Re-sign with the destination's secret(s) so the receiver can verify webhook.co (S3 Slice 2). The
    // webhook-id is THIS attempt's id (a fresh idempotency key per delivery). No secret on the destination
    // ⇒ no `signing` ⇒ delivered unsigned (the 1b verbatim behavior). The engine unseals + signs.
    const signing: DeliverySigning | undefined =
      claimed.signingSecrets.length > 0
        ? {
            webhookId: claimed.attempt.id,
            timestamp: Math.floor(Date.now() / 1000),
            secrets: claimed.signingSecrets.map((s) => ({ sealed: s.sealed, context: s.context })),
          }
        : undefined;

    let result: DeliverResult;
    try {
      result = await deps.dispatcher.deliver({
        orgId: ctx.orgId,
        endpointId: claimed.event.endpointId,
        dedupKey: claimed.event.dedupKey,
        url: claimed.destinationUrl,
        headers: claimed.event.headers,
        signing,
      });
    } catch (err: unknown) {
      console.log(JSON.stringify({ message: "remote_replay.dispatch_failed", error: String(err) }));
      result = { outcome: "failed", status: null, error: "delivery dispatch failed", latencyMs: 0 };
    }

    // tx2: finalize the claimed row with the real outcome (PK + status-guarded on 'pending'). A finalize
    // FAILURE must NOT 500 — that would prompt a retry → a second POST. Log it and return the real outcome
    // (the delivery already happened); Slice 4's lease reconciles a row left 'pending' by the failed write.
    const finalized = await withTenant(deps.tenant, ctx.orgId, (tx) =>
      finalizeDeliveryAttempt(tx, {
        id: claimed.attempt.id,
        status: result.outcome,
        statusCode: result.status,
        error: result.error,
      }),
    ).catch((err: unknown) => {
      console.log(
        JSON.stringify({
          message: "remote_replay.finalize_failed",
          attemptId: claimed.attempt.id,
          error: String(err),
        }),
      );
      return null;
    });
    return (
      finalized ?? {
        ...claimed.attempt,
        status: result.outcome,
        statusCode: result.status,
        error: result.error,
      }
    );
  };
}
