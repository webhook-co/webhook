// The api -> engine service-binding RPC contract for server-side remote delivery (ADR-0081, S3 1b).
// Single-sourced here so the engine's DeliveryDispatcher (the producer) and apps/api's binding type (the
// consumer) can't drift — the same pattern as the SecretSealer seam. apps/api types
// env.DELIVERY_DISPATCHER as DeliveryDispatcherRpc; the engine's class implements `deliver`.

export interface DeliverArgs {
  readonly orgId: string;
  readonly endpointId: string;
  readonly dedupKey: string;
  /** The destination URL (canonical at registration; re-validated by the connect-time guard at delivery). */
  readonly url: string;
  /** The event's captured headers ([name,value] pairs); filtered (hop-by-hop dropped) before the POST. */
  readonly headers: readonly (readonly [string, string])[];
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
