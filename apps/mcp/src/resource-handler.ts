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
// bearer seam, the PRM doc, the McpAgent hand-off, and the session-binding codec are all deps) so every
// branch is node-tested.
//
// PER-REQUEST PRINCIPAL ISOLATION (A8c): the McpAgent transport routes the Durable Object purely by the
// `Mcp-Session-Id`, and the DO's principal (`this.props`) is set once at session init. So a session id
// reused by a DIFFERENT principal would reach the first principal's DO. We close that here: the session id
// handed to the client is an HMAC-signed envelope BOUND to the initializing principal (bindSession); every
// request must present a session id that unbinds to the SAME principal (unbindSession) or it's rejected
// (404) BEFORE the transport sees it. The client only ever holds the bound id.

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
  /** Wrap a transport-assigned session id into an envelope bound to this principal (A8c). */
  readonly bindSession: (assignedId: string, principal: AuthContext) => Promise<string>;
  /** Open a presented session id → its base id ONLY if bound to this principal, else null (A8c). */
  readonly unbindSession: (presentedId: string, principal: AuthContext) => Promise<string | null>;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";
const SESSION_HEADER = "mcp-session-id";

function notFound(): Response {
  return new Response("not found", { status: 404 });
}

/**
 * The transport's "unknown session" outcome. An invalid-signature id and a valid id presented by the WRONG
 * principal are indistinguishable here (no oracle) — a stolen session id is useless to anyone but its owner.
 */
function sessionNotFound(): Response {
  return new Response("session not found", { status: 404 });
}

/** Clone a request with the `Mcp-Session-Id` header replaced (the body stream is carried over). */
function withRequestSession(request: Request, sessionId: string): Request {
  const headers = new Headers(request.headers);
  headers.set(SESSION_HEADER, sessionId);
  return new Request(request, { headers });
}

/** Clone a response with the `Mcp-Session-Id` header replaced (the body stream is carried over). */
function withResponseSession(res: Response, sessionId: string): Response {
  const headers = new Headers(res.headers);
  headers.set(SESSION_HEADER, sessionId);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
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

    // Per-request principal isolation (A8c): an inbound session id MUST unbind to the current principal.
    // A different principal presenting it (a stolen/reused id) → null → rejected here, before the transport
    // can route to another principal's DO. On unbind, the id is unwrapped to the base id the transport routes
    // by. A request with no inbound id (the `initialize`) passes straight through; its assigned id is wrapped
    // on the way out.
    let downstream = request;
    const inbound = request.headers.get(SESSION_HEADER);
    if (inbound !== null) {
      const baseId = await deps.unbindSession(inbound, authz.ctx);
      if (baseId === null) {
        deps.log?.("mcp.session_rejected", { orgId: authz.ctx.orgId });
        return sessionNotFound();
      }
      downstream = withRequestSession(request, baseId);
    }

    deps.setProps(ctx, authz.ctx);
    const res = await deps.serveMcp(downstream, env, ctx);

    // Re-wrap any transport-assigned session id (the `initialize` response, or an echo) back into the
    // principal-bound envelope, so the client only ever holds the bound id (bindSession is deterministic,
    // so a re-echo yields the same id the client already has).
    const assigned = res.headers.get(SESSION_HEADER);
    if (assigned === null) return res;
    return withResponseSession(res, await deps.bindSession(assigned, authz.ctx));
  }

  return notFound();
}
