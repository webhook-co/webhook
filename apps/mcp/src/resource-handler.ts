import {
  authenticateBearer,
  type AuthContext,
  type BearerAuthzDeps,
  type ProtectedResourceMetadata,
} from "@webhook-co/contract";

// A8b — the mcp resource-server router. mcp is no longer an OAuth issuer (the co-located OAuthProvider
// is torn down): it's a pure RESOURCE SERVER of the auth. issuer. This router:
//   - serves the RFC 9728 PRM (pointing `authorization_servers` at the auth. issuer, NOT mcp);
//   - challenges an unauthenticated /mcp request with 401 + a PRM-pointing WWW-Authenticate;
//   - on a valid bearer, sets the resolved principal on the execution context (the McpAgent reads it at
//     session init) and hands off to the WebhookMcp Durable Object.
//
// Authentication here is scope-FREE (authenticateBearer): the /mcp endpoint is a single JSON-RPC surface
// for many tools, and the per-capability scope check runs downstream in the shared read handler
// (packages/db read-handlers.ts) against ctx.scopes. The audience binding (RFC 8707) is enforced inside
// verifyBearer (both the api-key chain and introspection bind to MCP_RESOURCE). Pure + injected (the
// bearer seam, the PRM doc, and the McpAgent hand-off are all deps) so every branch is node-tested.

/** The slice of ExecutionContext this router uses — kept structural; index.ts passes the real ctx. */
export interface McpExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  /** The resolved principal the McpAgent reads at session init (set via deps.setProps). */
  props?: unknown;
}

export interface ResourceHandlerDeps {
  /** The shared bearer-authorize deps: verifyBearer (audience-bound) + resource + the PRM URL. */
  readonly authDeps: BearerAuthzDeps;
  /** The RFC 9728 PRM document served on the well-known path (built once at module load). */
  readonly resourceMetadata: ProtectedResourceMetadata;
  /** The PRM well-known path (GET, public, DB-free). */
  readonly prmPath: string;
  /** Hand an authenticated request to the McpAgent DO (WebhookMcp.serve("/mcp").fetch). */
  readonly serveMcp: (
    request: Request,
    env: unknown,
    ctx: McpExecutionContext,
  ) => Promise<Response>;
  /** Inject the resolved principal into the execution context for the McpAgent (a testable seam). */
  readonly setProps: (ctx: McpExecutionContext, props: AuthContext) => void;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

/**
 * Route a request to the mcp resource server. An operational fault from verifyBearer PROPAGATES (the
 * index.ts wrapper turns it into a 500) — never masked as a 401; an expected auth rejection is the 401
 * challenge. The hand-off sets props BEFORE serving so the McpAgent has the principal at session init.
 */
export async function handleResourceRequest(
  deps: ResourceHandlerDeps,
  request: Request,
  env: unknown,
  ctx: McpExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  // Public, DB-free routes.
  if (request.method === "GET" && url.pathname === deps.prmPath) {
    return Response.json(deps.resourceMetadata);
  }
  if (request.method === "GET" && url.pathname === HEALTH_PATH) {
    return new Response("mcp ok", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (url.pathname === MCP_PATH) {
    // A CORS preflight carries no credential and returns only CORS headers — let the McpAgent transport
    // answer it (origin/headers), without requiring (or setting) a principal.
    if (request.method === "OPTIONS") {
      return deps.serveMcp(request, env, ctx);
    }
    const authz = await authenticateBearer(deps.authDeps, request.headers.get("authorization"));
    if (!authz.ok) {
      return new Response(null, {
        status: authz.status,
        headers: { "www-authenticate": authz.challenge },
      });
    }
    deps.setProps(ctx, authz.ctx);
    return deps.serveMcp(request, env, ctx);
  }

  return notFound();
}
