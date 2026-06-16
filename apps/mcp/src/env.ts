// Bindings for the mcp. OAuth issuer+resource Worker. The OAuth layer needs the provider's KV
// store (token/grant/client) and — now that the MCP tool dispatch is live — the same DB/KV/secret
// set apps/api uses: the api-key cold lookup (webhook_authn), the RLS-scoped tenant reads, the KV
// credential cache, and the pepper/cursor/audit secrets. The McpAgent tools run inside the
// MCP_OBJECT Durable Object; resolveExternalToken (the api-key bridge) runs out here on the Worker.
export interface McpEnv {
  /** The OAuthProvider's token / grant / client store (required by the library). */
  OAUTH_KV: KVNamespace;
  /** The McpAgent Durable Object namespace. `WebhookMcp.serve("/mcp")` looks it up by this name. */
  MCP_OBJECT: DurableObjectNamespace;
  /** webhook_authn Hyperdrive (caching OFF): the api-key cold lookup (org-discovery-by-hash). */
  HYPERDRIVE_AUTHN: Hyperdrive;
  /** Cache-disabled Hyperdrive for authenticated tenant-scoped reads (RLS-gated) inside the DO. */
  HYPERDRIVE_TENANT: Hyperdrive;
  /** KV caching resolved principals (keyed by api-key hash); invalidated on revoke. */
  KV_AUTHZ: KVNamespace;
  // Secrets are Cloudflare Secrets Store bindings (read via `await readSecretBinding(env.X)`); the trio
  // below is ONE account secret each, shared byte-identically with engine + api. Never DB columns.
  /** Base64 credential pepper: keys the api-key HMAC (same pepper across surfaces). */
  CREDENTIAL_PEPPER: SecretsStoreSecret;
  /** Base64 HMAC key for opaque pagination cursors (must equal the other surfaces' CURSOR_KEY). */
  CURSOR_KEY: SecretsStoreSecret;
  /** Base64 audit-chain HMAC key — the same key the chain rows are signed with. */
  AUDIT_CHAIN_HMAC_KEY: SecretsStoreSecret;
}
