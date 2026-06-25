// Bindings for the mcp. RESOURCE-SERVER Worker (A8 — the co-located OAuth issuer is gone, so its OAUTH_KV
// token/grant/client store is gone too). It needs the same DB/KV/secret set apps/api uses: the api-key
// cold lookup (webhook_authn), the RLS-scoped tenant reads, the KV credential cache, and the pepper/cursor/
// audit secrets — plus the AUTH_ISSUER service binding to validate opaque OAuth tokens via introspection.
// The McpAgent tools run inside the MCP_OBJECT Durable Object; bearer resolution runs out here on the Worker.

import type { TokenIntrospector } from "@webhook-co/contract";

export interface McpEnv {
  /** The McpAgent Durable Object namespace. `WebhookMcp.serve("/mcp")` looks it up by this name. */
  MCP_OBJECT: DurableObjectNamespace;
  /**
   * Service binding to auth.'s IssuerIntrospect WorkerEntrypoint — validates an opaque OAuth provider
   * token (mcp can't validate it locally; it's KV-bound to auth.). Deploy-injected (see wrangler.jsonc);
   * only dereferenced for a non-`whk_` token, so the api-key path never touches it.
   */
  AUTH_ISSUER: TokenIntrospector;
  /** webhook_authn Hyperdrive (caching OFF): the api-key cold lookup (org-discovery-by-hash). */
  HYPERDRIVE_AUTHN: Hyperdrive;
  /** Cache-disabled Hyperdrive for authenticated tenant-scoped reads (RLS-gated) inside the DO. */
  HYPERDRIVE_TENANT: Hyperdrive;
  /** KV caching resolved principals (keyed by api-key hash); invalidated on revoke. */
  KV_AUTHZ: KVNamespace;
  /**
   * The engine's ingest-token cache namespace (the SAME KV_CONFIG the engine reads on the wbhk.my hot
   * path). mcp binds it ONLY to EVICT a token's entry after the endpoints.delete / endpoints.rotate tools
   * (ADR-0076), via makeIngestHashEvictor — never to read/write principals. Same namespace by id (KV is
   * global-by-id; overlay-injected). The McpAgent DO reads it from env on each write-tool call.
   */
  KV_CONFIG: KVNamespace;
  /**
   * The cookieless ingest apex the endpoints.create tool builds its one-time ingest URL from (prod:
   * https://wbhk.my). A plain wrangler `vars` value (NOT a secret, NOT deploy-injected — the overlay
   * carries no `vars`, so it is committed in wrangler.jsonc). Must match api's INGEST_BASE_URL + the
   * engine route apex.
   */
  INGEST_BASE_URL: string;
  // Secrets are Cloudflare Secrets Store bindings (read via `await readSecretBinding(env.X)`); the trio
  // below is ONE account secret each, shared byte-identically with engine + api. Never DB columns.
  /** Base64 credential pepper: keys the api-key HMAC (same pepper across surfaces). */
  CREDENTIAL_PEPPER: SecretsStoreSecret;
  /** Base64 HMAC key for opaque pagination cursors (must equal the other surfaces' CURSOR_KEY). */
  CURSOR_KEY: SecretsStoreSecret;
  /** Base64 audit-chain HMAC key — the same key the chain rows are signed with. */
  AUDIT_CHAIN_HMAC_KEY: SecretsStoreSecret;
  /**
   * Base64 32-byte HMAC key for the per-request session-binding envelope (A8c) — mcp-specific (NOT shared),
   * dedicated to signing the principal-bound `Mcp-Session-Id`. Deploy-provisioned in the Secrets Store.
   */
  MCP_SESSION_KEY: SecretsStoreSecret;
}
