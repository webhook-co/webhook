// The api/mcp/web -> engine service-binding RPC contract for the ingest-URL reveal (S8-remainder Slice 2,
// ADR-0101). Single-sourced here so the engine's IngestUrlRevealer (the producer) and the consumers' binding
// types can't drift — the same pattern as SecretSealer / DeliveryDispatcherRpc. Consumers type
// env.INGEST_URL_REVEALER as IngestUrlRevealerRpc; the engine's class implements `revealIngestToken`.

/** The reveal outcome the engine returns over the binding (structured-clone-safe; no thrown types). */
export interface RevealedIngestToken {
  /** False when the endpoint is unknown / cross-org (RLS-invisible) → the caller maps this to NOT_FOUND. */
  readonly found: boolean;
  /** The plaintext ingest token, or null when there is no recoverable copy / the wrapper failed to parse. */
  readonly token: string | null;
}

/**
 * The narrow RPC surface api/mcp/web call over the service binding
 * (env.INGEST_URL_REVEALER.revealIngestToken). IDENTIFIER-only by construction: the consumer passes UUIDs
 * and the engine reads + unseals the sealed blob itself — a caller never supplies ciphertext (which would
 * make the unseal a decrypt-anything oracle). The engine is the sole KEK holder, so the unseal happens only
 * there; this seam exposes reveal ONLY (no generic open), for the ingest token ONLY.
 */
export interface IngestUrlRevealerRpc {
  revealIngestToken(orgId: string, endpointId: string): Promise<RevealedIngestToken>;
}
