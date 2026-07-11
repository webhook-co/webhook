// The web -> engine service-binding RPC contract for on-demand soft-cap re-evaluation (WS3, the overage
// toggle). Single-sourced here so the engine's CapReEvaluator (the producer) and the web consumer's binding
// type can't drift — same pattern as IngestUrlRevealerRpc / DeliveryDispatcherRpc. The web tier flips
// org_limits.pause_policy in the DB, then calls this so enforcement (ingest_paused + the edge KV cache)
// reflects the new policy IMMEDIATELY, instead of waiting up to an hour for the metering cron's next pass.

/** The re-evaluation outcome (structured-clone-safe; no thrown types). */
export interface OrgCapReEvaluated {
  /** The org's resulting durable pause state after re-evaluation. */
  readonly paused: boolean;
  /** True when this call flipped ingest_paused (pause↔resume); false when it was already settled. */
  readonly transitioned: boolean;
}

/**
 * The narrow RPC surface the web tier calls over the service binding (env.CAP_REEVALUATOR.reevaluateOrgCap).
 * IDENTIFIER-only: the consumer passes the org id and the engine reads usage/limits/pause under that org's
 * RLS, decides pause/resume on the SAME basis the cron uses, flips ingest_paused on a transition, and evicts
 * the org's ingest-token cache entries. No policy value crosses the wire — the DB is already the source of
 * truth; this seam only asks the engine to reconcile enforcement to it now.
 */
export interface CapReEvaluatorRpc {
  reevaluateOrgCap(orgId: string): Promise<OrgCapReEvaluated>;
}
