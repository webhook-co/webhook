// The MCP server's auth surface. Same contract seam as the REST API (VerifyBearer,
// AuthContext, the scope check, the 401/403 distinction) PLUS the RFC 9728
// resource-server obligation: MCP serves a protected-resource-metadata document so an
// MCP client can discover the issuer and run dynamic client registration. As with the
// API surface, verifyBearer is INJECTED — this never imports the api-key implementation.

import {
  buildProtectedResourceMetadata,
  buildWwwAuthenticate,
  CAPABILITY_REGISTRY,
  type AuthContext,
  type ProtectedResourceMetadata,
  type VerifyBearer,
} from "@webhook-co/contract";

export type McpAuthzResult =
  | { readonly ok: true; readonly ctx: AuthContext }
  | { readonly ok: false; readonly status: 401 | 403; readonly challenge: string };

export interface McpAuthDeps {
  readonly verifyBearer: VerifyBearer;
  /** This resource's identifier (RFC 8707 audience). */
  readonly resource: string;
  /** Absolute URL of the PRM document (RFC 9728). */
  readonly resourceMetadataUrl: string;
  /** The OAuth authorization server(s) an MCP client should use. */
  readonly authorizationServers: readonly string[];
}

/** Pull a Bearer token out of the Authorization header, or null if absent/malformed. */
export function extractBearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
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
 * Authorize an MCP tool call against `capabilityName`. Identical seam to the API surface:
 * resolve via verifyBearer (audience-bound), then enforce the capability's scope.
 * 401 (no/invalid credential or wrong audience) vs 403 (under-scoped).
 */
export async function authorize(
  deps: McpAuthDeps,
  req: Request,
  capabilityName: string,
): Promise<McpAuthzResult> {
  const capability = CAPABILITY_REGISTRY.get(capabilityName);
  if (!capability) {
    throw new Error(`unknown capability: ${capabilityName}`);
  }

  const token = extractBearer(req);
  // eslint-disable-next-line security/detect-possible-timing-attacks -- a null PRESENCE check, not a secret compare; the real compare is the constant-time hash in @webhook-co/db
  if (token === null) {
    return unauthenticated(deps);
  }

  let ctx: AuthContext;
  try {
    ctx = await deps.verifyBearer(token, deps.resource);
  } catch {
    return unauthenticated(deps);
  }

  if (!ctx.scopes.includes(capability.auth.scope)) {
    return {
      ok: false,
      status: 403,
      challenge: buildWwwAuthenticate(deps.resourceMetadataUrl, "insufficient_scope"),
    };
  }

  return { ok: true, ctx };
}

function unauthenticated(deps: McpAuthDeps): McpAuthzResult {
  return {
    ok: false,
    status: 401,
    challenge: buildWwwAuthenticate(deps.resourceMetadataUrl, "invalid_token"),
  };
}
