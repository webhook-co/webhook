import { grantPropsToAuthContext } from "./grant";
import type { AuthedExecutionContext, McpEnv } from "./env";

// The authenticated MCP API handler. The OAuthProvider routes a request here ONLY
// after it has validated the access token (opaque, KV-backed) AND enforced the RFC 8707 resource
// binding, exposing the grant on `ctx.props`. So this handler never re-checks the token — it turns
// the already-authenticated grant into our AuthContext (the trust boundary in grant.ts).
//
// AUTHORIZATION SCOPE: this endpoint returns the caller's OWN grant identity (its orgId + the scopes
// IT was granted) — there is nothing to authorize beyond authentication, so it is intentionally not
// scope-gated and serves NO capability. When the MCP JSON-RPC tool dispatch lands (a later binding),
// EACH tool call MUST enforce its capability's required scope (403 insufficient_scope, via the
// contract's buildWwwAuthenticate) before doing any privileged work — this handler is not that gate.

export const mcpApiHandler = {
  async fetch(_request: Request, _env: McpEnv, ctx: ExecutionContext): Promise<Response> {
    let auth;
    try {
      auth = grantPropsToAuthContext((ctx as AuthedExecutionContext).props);
    } catch (err) {
      // The provider already authenticated the token, so a malformed grant is OUR mint-shape bug or
      // a poisoned store — a server-side integrity event. Log it (props carry no secret/PII and are
      // never echoed to the client) and fail CLOSED with a generic 500.
      console.error(JSON.stringify({ message: "mcp: malformed grant props", error: String(err) }));
      return new Response("internal error", { status: 500 });
    }
    // The caller's own resolved identity. `auth` IS an AuthContext, so serializing it directly keeps
    // the wire response from drifting away from the contract shape.
    return Response.json(auth);
  },
} satisfies ExportedHandler<McpEnv>;
