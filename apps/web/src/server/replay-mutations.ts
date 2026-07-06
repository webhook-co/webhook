import "server-only";

import { withTenant, type Sql } from "@webhook-co/db/client";
import { getReplayDestination } from "@webhook-co/db/replay-destinations";
import {
  claimDeliveryAttempt,
  finalizeDeliveryAttempt,
  serializeTarget,
} from "@webhook-co/db/replay";
import { getEvent } from "@webhook-co/db/reads";
import { getActiveSigningSecrets } from "@webhook-co/db/signing-keys";
import {
  deliveryVerificationDecision,
  type DeliverArgs,
  type DeliverResult,
  type DeliveryAttempt,
  type DeliveryDispatcherRpc,
  type DeliverySigning,
} from "@webhook-co/shared";

import { withTenantDb } from "./db";
import { getDeliveryDispatcher } from "./env";

// The web-side orchestration for a REMOTE replay (events.replay with {kind:"destination"}, ADR-0081) — the
// session counterpart of apps/api's `createRemoteReplayHandler`. The server delivers; the web worker never
// fetches a destination itself. The outbound POST + the AUTHORITATIVE connect-time SSRF guard + the
// Standard-Webhooks re-signing all happen in the ENGINE (the DELIVERY_DISPATCHER binding); this tier only
// resolves under RLS, claims a delivery row, relays SEALED signing ciphertext, and finalizes. This mirrors
// the api handler branch-for-branch (kept at parity deliberately — the engine-spanning orchestration is
// app-local by design, not in packages/db). Flow: resolve event+destination under RLS → CLAIM a 'pending'
// delivery_attempt [tx1] → engine deliver [no db tx held across the POST] → FINALIZE the real outcome [tx2].
// A FRESH idempotency key is minted per invocation (ADR-0016), so claim-first only dedups a transient retry.

/** Raised when the event OR the destination isn't resolvable under RLS (one code — no cross-org existence oracle). */
export class ReplayNotFoundError extends Error {
  constructor(message = "event or destination not found") {
    super(message);
    this.name = "ReplayNotFoundError";
  }
}

/** Raised when the engine delivery binding is absent — fail closed rather than silently no-op a replay. */
export class DispatcherUnavailableError extends Error {
  constructor() {
    super("DELIVERY_DISPATCHER is not configured");
    this.name = "DispatcherUnavailableError";
  }
}

/** Raised when a non-won re-claim's row belongs to a different event/target (a key collision) — never a false success. */
export class ReplayConflictError extends Error {
  constructor() {
    super("idempotency key already used for a different replay");
    this.name = "ReplayConflictError";
  }
}

/** Raised when the event's signature was checked and REJECTED (`failed`) — it must never be replayed to a
 *  destination (which would re-sign forged content with our secret). S8-remainder Slice 3 / ADR-0103. */
export class ReplayUnverifiedError extends Error {
  constructor() {
    super("this event's signature was rejected — it can't be replayed to a destination");
    this.name = "ReplayUnverifiedError";
  }
}

export interface ReplayInput {
  readonly orgId: string;
  readonly eventId: string;
  readonly destinationId: string;
}

/** The resolved-and-claimed context, a not-found sentinel (event or destination invisible under RLS), or a
 *  blocked sentinel (a `failed` event that must not be replayed — ADR-0103). */
export type ClaimOutcome =
  | { readonly kind: "not_found" }
  | { readonly kind: "blocked" }
  | {
      readonly kind: "claimed";
      readonly event: {
        readonly endpointId: string;
        /** The STORED R2 object key for the body — the engine resolves it directly (never re-derives),
         *  fenced to the endpoint prefix at the dispatcher (ADR-0104 forged-overwrite hardening). */
        readonly payloadR2Key: string;
        readonly headers: DeliverArgs["headers"];
        /** Whether the source event VERIFIED — the engine re-signs ONLY a verified event (ADR-0103). */
        readonly verified: boolean;
      };
      readonly destinationUrl: string;
      /** The destination's active(+retiring) SEALED signing secrets, in the shape the engine's signing wants. */
      readonly signingSecrets: DeliverySigning["secrets"];
      readonly attempt: DeliveryAttempt;
      readonly won: boolean;
    };

export interface ClaimInput extends ReplayInput {
  readonly target: string;
  readonly idempotencyKey: string;
}

export interface FinalizeInput {
  readonly orgId: string;
  readonly id: string;
  readonly status: DeliverResult["outcome"];
  readonly statusCode: number | null;
  readonly error: string | null;
}

/**
 * Injectable boundaries for the glue unit tests; the pure orchestration (idempotency-key mint, the
 * won/not-found branching, the dispatch-failure synthesis, the finalize-null fallback, the signing
 * construction) is NOT injected so a test still exercises the real security logic. The default binds the
 * per-request tenant pool + the engine dispatcher.
 */
export interface ReplayDeps {
  claim(input: ClaimInput): Promise<ClaimOutcome>;
  dispatch(args: DeliverArgs): Promise<DeliverResult>;
  finalize(input: FinalizeInput): Promise<DeliveryAttempt | null>;
}

/** Bind the real db helpers + the engine dispatcher over a tenant pool — the default (non-injected) boundary. */
function boundDeps(app: Sql, dispatcher: DeliveryDispatcherRpc): ReplayDeps {
  return {
    claim: (input) =>
      withTenant(app, input.orgId, async (tx): Promise<ClaimOutcome> => {
        const event = await getEvent(tx, input.eventId);
        if (!event) return { kind: "not_found" };
        // SECURITY GATE (ADR-0103): a `failed` event (signature checked + REJECTED = forged) must never be
        // replayed to a destination (which would re-sign attacker content with our secret). `unattempted`
        // still replays but is delivered UNSIGNED (the signing gate below keys on event.verified).
        if (!deliveryVerificationDecision(event.verified, event.verification).deliver) {
          return { kind: "blocked" };
        }
        // Resolves any LIVE (deleted_at is null) destination — NOT gated on disabled_at, matching the api
        // remote-replay handler exactly (a manual replay is a deliberate act; `disabled` pauses the engine's
        // AUTOMATIC delivery loop, not an explicit replay). The UI hides disabled rows from the picker as a
        // UX nicety; changing this to reject disabled targets is a cross-surface (CLI/API/web) product call.
        const destination = await getReplayDestination(tx, input.destinationId);
        if (!destination) return { kind: "not_found" };
        // Active(+retiring) signing secrets — SEALED; the engine alone unseals to sign (S3 Slice 2).
        const signingSecrets = await getActiveSigningSecrets(tx, destination.id);
        const { attempt, won } = await claimDeliveryAttempt(tx, {
          orgId: input.orgId,
          eventId: input.eventId,
          destinationId: destination.id,
          target: input.target,
          idempotencyKey: input.idempotencyKey,
        });
        return {
          kind: "claimed",
          event: {
            endpointId: event.endpointId,
            payloadR2Key: event.payloadR2Key,
            headers: event.headers as DeliverArgs["headers"],
            verified: event.verified,
          },
          destinationUrl: destination.url,
          signingSecrets: signingSecrets.map((s) => ({ sealed: s.sealed, context: s.context })),
          attempt,
          won,
        };
      }),
    dispatch: (args) => dispatcher.deliver(args),
    // A throw here (a real db fault) PROPAGATES to the orchestration's finalize catch (which logs + falls
    // back); a legit `null` (row no longer 'pending') is returned as-is. No catch swallowing here.
    finalize: (input) =>
      withTenant(app, input.orgId, (tx) =>
        finalizeDeliveryAttempt(tx, {
          id: input.id,
          status: input.status,
          statusCode: input.statusCode,
          error: input.error,
        }),
      ),
  };
}

/**
 * Replay a captured event to a registered destination via the engine. Resolves the returned
 * `DeliveryAttempt` (delivered / failed / blocked are all successful RESOLUTIONS — the caller renders the
 * status honestly). Throws `ReplayNotFoundError` (event/destination gone) or `DispatcherUnavailableError`
 * (engine binding absent). The delivery is at-least-once (a fresh key per call); a receiver dedups by
 * webhook-id.
 */
export async function replayToDestination(
  input: ReplayInput,
  injected?: ReplayDeps,
): Promise<DeliveryAttempt> {
  if (injected) return orchestrate(input, injected);
  // Fail closed BEFORE opening the pool: a replay with no engine binding must error, never silently no-op.
  const dispatcher = getDeliveryDispatcher();
  if (!dispatcher) throw new DispatcherUnavailableError();
  // withTenantDb centralizes the per-request pool acquire/best-effort-release (one pool spans claim tx +
  // engine POST + finalize tx); no db tx is held across the POST.
  return withTenantDb((app) => orchestrate(input, boundDeps(app, dispatcher)));
}

/** The pure orchestration over the injected boundary (claim → deliver → finalize); no pool lifecycle here. */
async function orchestrate(input: ReplayInput, deps: ReplayDeps): Promise<DeliveryAttempt> {
  const idempotencyKey = crypto.randomUUID();
  const target = serializeTarget({ kind: "destination", destinationId: input.destinationId });
  const claimed = await deps.claim({ ...input, target, idempotencyKey });
  if (claimed.kind === "not_found") throw new ReplayNotFoundError();
  if (claimed.kind === "blocked") throw new ReplayUnverifiedError();
  if (!claimed.won) {
    // A fresh key ⇒ won is practically always true; a non-won re-claim can only be a same-(event,target)
    // sibling (a transient retry) → return it (idempotent, no re-POST). Defense-in-depth (api parity): if the
    // claimed row somehow belongs to a DIFFERENT event/target (an astronomically-unlikely uuid collision),
    // reject rather than report that foreign row's status as THIS replay's — never a false success.
    if (claimed.attempt.eventId !== input.eventId || claimed.attempt.target !== target) {
      throw new ReplayConflictError();
    }
    return claimed.attempt;
  }

  // Re-sign with the destination's sealed secret(s) so the receiver can verify webhook.co; the webhook-id is
  // THIS attempt's id. No secret ⇒ no signing ⇒ delivered unsigned. The engine unseals + signs.
  // Re-sign ONLY a verified event (ADR-0103): an `unattempted` event is delivered UNSIGNED even to a signing
  // destination — we never vouch (sign) for content we didn't authenticate.
  const signing: DeliverySigning | undefined =
    claimed.event.verified && claimed.signingSecrets.length > 0
      ? {
          webhookId: claimed.attempt.id,
          timestamp: Math.floor(Date.now() / 1000),
          // Already the {sealed, context} shape (projected in the claim boundary) — relay as-is.
          secrets: claimed.signingSecrets,
        }
      : undefined;

  let result: DeliverResult;
  try {
    result = await deps.dispatch({
      orgId: input.orgId,
      endpointId: claimed.event.endpointId,
      payloadR2Key: claimed.event.payloadR2Key,
      url: claimed.destinationUrl,
      headers: claimed.event.headers,
      signing,
    });
  } catch (err: unknown) {
    // Outcome UNKNOWN → record 'failed' (terminal, retryable) rather than leaving the claim stuck 'pending'.
    console.log(JSON.stringify({ message: "web_replay.dispatch_failed", error: String(err) }));
    result = { outcome: "failed", status: null, error: "delivery dispatch failed", latencyMs: 0 };
  }

  // A finalize FAILURE must NOT throw — the delivery already happened; a throw would prompt a retry → a
  // second POST. Log + fall back to the claimed row stamped with the real outcome; the lease reconciles later.
  const finalized = await deps
    .finalize({
      orgId: input.orgId,
      id: claimed.attempt.id,
      status: result.outcome,
      statusCode: result.status,
      error: result.error,
    })
    .catch((err: unknown) => {
      console.log(
        JSON.stringify({
          message: "web_replay.finalize_failed",
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
}
