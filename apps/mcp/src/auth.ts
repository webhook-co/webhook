// The MCP server's auth surface. Same contract seam as the REST API (VerifyBearer,
// AuthContext, the scope check, the 401/403 distinction) PLUS the RFC 9728
// resource-server obligation: MCP serves a protected-resource-metadata document so an
// MCP client can discover the issuer and run dynamic client registration. As with the
// API surface, verifyBearer is INJECTED — this never imports the api-key implementation.

import {
  authorizeBearer,
  buildProtectedResourceMetadata,
  CAPABILITY_REGISTRY,
  extractBearer as extractBearerHeader,
  type BearerAuthzDeps,
  type BearerAuthzResult,
  type ProtectedResourceMetadata,
} from "@webhook-co/contract";

export type McpAuthzResult = BearerAuthzResult;

export interface McpAuthDeps extends BearerAuthzDeps {
  /** The OAuth authorization server(s) an MCP client should use. */
  readonly authorizationServers: readonly string[];
}

/** Pull a Bearer token out of a request's Authorization header, or null if absent/malformed. */
export function extractBearer(req: Request): string | null {
  return extractBearerHeader(req.headers.get("authorization"));
}

/**
 * The /.well-known/oauth-protected-resource document for this MCP resource. scopes_supported
 * advertises the capability scopes the server understands so a client can request them.
 */
export function protectedResourceMetadata(deps: McpAuthDeps): ProtectedResourceMetadata {
  const scopes = [...new Set([...CAPABILITY_REGISTRY.values()].map((c) => c.auth.scope))].sort();
  return buildProtectedResourceMetadata({
    resource: deps.resource,
    authorizationServers: deps.authorizationServers,
    scopesSupported: scopes,
  });
}

/**
 * Authorize an MCP tool call against `capabilityName`. Identical seam to the API surface —
 * a thin adapter over the shared `authorizeBearer` decision (401 vs 403; operational faults
 * propagate as 5xx). The PRM document above is the MCP-only resource-server obligation.
 */
export function authorize(
  deps: McpAuthDeps,
  req: Request,
  capabilityName: string,
): Promise<McpAuthzResult> {
  return authorizeBearer(deps, req.headers.get("authorization"), capabilityName);
}
