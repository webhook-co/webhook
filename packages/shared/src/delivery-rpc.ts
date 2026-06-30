// The api -> engine service-binding RPC contract for server-side remote delivery (ADR-0081, S3 1b).
// Single-sourced here so the engine's DeliveryDispatcher (the producer) and apps/api's binding type (the
// consumer) can't drift — the same pattern as the SecretSealer seam. apps/api types
// env.DELIVERY_DISPATCHER as DeliveryDispatcherRpc; the engine's class implements `deliver`.

import { type EncryptionContext } from "./envelope";
import { type SealedRecord } from "./secret-store";

/**
 * A SEALED outbound signing secret + the AAD context to unseal it, as relayed api -> engine (S3 Slice 2,
 * ADR-0084). The api reads these (ciphertext only) from signing_keys under RLS and hands them over the
 * binding; ONLY the engine holds the KEK, so only the engine unseals them to sign. The api never sees the
 * `whsec_` plaintext. SealedRecord's byte fields (Uint8Array) cross the service binding by structured clone.
 */
export interface SealedSigningSecret {
  readonly sealed: SealedRecord;
  readonly context: EncryptionContext;
}

/**
 * The Standard Webhooks signing instruction for one delivery (S3 Slice 2). The engine signs the body with
 * every supplied secret (active + retiring, for rotation overlap) under `webhookId`/`timestamp`, strips any
 * inbound signature headers, and sets `webhook-id`/`webhook-timestamp`/`webhook-signature`. `webhookId` is
 * the receiver's idempotency key — a FRESH id per delivery (the delivery-attempt id), so a deliberate
 * replay is not deduped as a stale duplicate.
 */
export interface DeliverySigning {
  readonly webhookId: string;
  /** Unix seconds; the receiver enforces its replay window around this. */
  readonly timestamp: number;
  /** Active (+ retiring) sealed signing secrets, newest first; each yields one space-delimited `v1` sig. */
  readonly secrets: readonly SealedSigningSecret[];
}

export interface DeliverArgs {
  readonly orgId: string;
  readonly endpointId: string;
  readonly dedupKey: string;
  /** The destination URL (canonical at registration; re-validated by the connect-time guard at delivery). */
  readonly url: string;
  /** The event's captured headers ([name,value] pairs); filtered (hop-by-hop dropped) before the POST. */
  readonly headers: readonly (readonly [string, string])[];
  /**
   * Sign the delivery (S3 Slice 2). When present, the engine re-signs with the destination's secret(s) and
   * the inbound provider signature is stripped (the receiver verifies webhook.co, not the original sender).
   * Absent ⇒ delivered unsigned (no destination signing secret), preserving the 1b verbatim behavior.
   */
  readonly signing?: DeliverySigning;
}

/** delivered = a 2xx response · failed = a non-2xx/3xx, a connection error, or a transient resolver
 *  failure (retryable) · blocked = the SSRF guard refused (no request was made). The api maps this 1:1
 *  to the delivery_attempts status. */
export type DeliveryOutcome = "delivered" | "failed" | "blocked";

export interface DeliverResult {
  readonly outcome: DeliveryOutcome;
  readonly status: number | null;
  readonly error: string | null;
  readonly latencyMs: number;
}

/** The narrow RPC surface apps/api calls over the service binding (env.DELIVERY_DISPATCHER.deliver). */
export interface DeliveryDispatcherRpc {
  deliver(args: DeliverArgs): Promise<DeliverResult>;
}
