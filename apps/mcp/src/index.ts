import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { CAPABILITY_REGISTRY } from "@webhook-co/contract";

import { mcpApiHandler } from "./api-handler";
import { mcpDefaultHandler } from "./default-handler";

// The mcp. OAuth issuer + resource server (§0.8, WS-D2a; ADR-0010 r2). Co-located on mcp.:
// @cloudflare/workers-oauth-provider runs here as our own OAuth 2.1 issuer for mcp.-scoped access
// tokens AND validates them as the resource server. The PRD §6 "issuer on auth., separate resource
// server on mcp." split is infeasible — the library's tokens are opaque + KV-bound to the issuing
// Worker (no JWT/introspection/cross-Worker validation) — so mcp. issues+validates its own tokens
// and federates user LOGIN to Better Auth on auth. (the identity origin). The provider serves the
// RFC 9728 PRM, RFC 8414 metadata, RFC 7591 DCR, and the /token endpoint; it enforces RFC 8707
// resource binding and S256-only PKCE. We never hand-roll OAuth.

/** Our canonical MCP resource identifier (RFC 9728 `resource` / RFC 8707 audience). */
export const MCP_RESOURCE = "https://mcp.webhook.co";

/** The distinct capability scopes the MCP surface understands (RFC 8414 `scopes_supported`). */
export const SCOPES_SUPPORTED: string[] = [
  ...new Set([...CAPABILITY_REGISTRY.values()].map((c) => c.auth.scope)),
].sort();

export default new OAuthProvider({
  // The single MCP endpoint. Requests here are validated (token + RFC 8707 resource) before the
  // apiHandler runs; everything else (PRM, metadata, /token, /register, /authorize) is the provider
  // or the defaultHandler.
  apiRoute: ["/mcp"],
  apiHandler: mcpApiHandler,
  defaultHandler: mcpDefaultHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",

  scopesSupported: SCOPES_SUPPORTED,
  // OAuth 2.1 hardening: no implicit flow, S256-only PKCE (reject `plain`).
  allowImplicitFlow: false,
  allowPlainPKCE: false,

  // RFC 9728 PRM: advertise our canonical resource + this co-located issuer as the auth server.
  // The resource identifier is the origin (the stable RFC 8707 audience), while the protected API
  // is at /mcp. The end-to-end resource-binding on a VALID access token (origin-bound token reaching
  // /mcp) can only be exercised once the /authorize login flow can mint a token — verify it in WS-D2b.
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [MCP_RESOURCE],
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ["header"],
    resource_name: "webhook.co MCP",
  },
});
