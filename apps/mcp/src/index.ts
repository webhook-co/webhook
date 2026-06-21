import {
  buildProtectedResourceMetadata,
  CAPABILITY_REGISTRY,
  type ProtectedResourceMetadata,
} from "@webhook-co/contract";
import {
  createClient,
  createCredentialHasherFromBase64,
  makeApiKeyAuthDeps,
  MCP_RESOURCE,
} from "@webhook-co/db";
import { b64ToBytes, readSecretBinding } from "@webhook-co/shared";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";

import { makeIntrospectVerifyBearer } from "./introspect-client";
import { makeResourceVerifyBearer } from "./resolve-bearer";
import { handleResourceRequest, type ResourceHandlerDeps } from "./resource-handler";
import {
  bindSessionId,
  importSessionKey,
  principalDigest,
  unbindSessionId,
} from "./session-binding";
import { WebhookMcp } from "./mcp-agent";
import type { McpEnv } from "./env";

// The mcp.webhook.co MCP server — now a pure RESOURCE SERVER of the auth. issuer (A8). The co-located
// @cloudflare/workers-oauth-provider issuer is GONE: Lane C stood up the real OAuth issuer on
// auth.webhook.co (login → consent → mint, refresh, revoke, device flow, introspection), so one issuer
// serves many resources (api., mcp.). This Worker validates two bearer kinds and dispatches to the
// WebhookMcp Durable Object (McpAgent), which registers the read capabilities as MCP tools:
//   1. a first-party `whk_` access key (the CLI / api-key callers) → the api-key credential chain;
//   2. an opaque OAuth provider token (generic 3rd-party MCP clients) → introspected over the AUTH_ISSUER
//      service binding (auth.'s IssuerIntrospect — mcp can't validate it locally, it's KV-bound to auth.).
// Both bind to MCP_RESOURCE (RFC 8707). The two-validator dispatch + the introspection adapter are A8a;
// this file wires the real per-request deps + the resource-server router (resource-handler, A8b).
//
// MCP_RESOURCE (RFC 9728 `resource` / RFC 8707 audience) is single-sourced in @webhook-co/db.

const PRM_PATH = "/.well-known/oauth-protected-resource";
const HEALTH_PATH = "/healthz";
/** The OAuth issuer for this resource — now auth.webhook.co (the Lane C issuer), NOT the old co-located one. */
const AUTH_ISSUER = "https://auth.webhook.co";

/** The distinct capability scopes the MCP surface understands (RFC 8414 `scopes_supported`). */
export const SCOPES_SUPPORTED: string[] = [
  ...new Set([...CAPABILITY_REGISTRY.values()].map((c) => c.auth.scope)),
].sort();

// The McpAgent Durable Object class must be exported from the Worker entry so wrangler can bind it
// (durable_objects.bindings[].class_name = "WebhookMcp").
export { WebhookMcp } from "./mcp-agent";

// Built once at module load (pure): the RFC 9728 PRM advertising our resource + the auth. issuer as the
// authorization server, and the McpAgent streamable-HTTP handler.
const RESOURCE_METADATA: ProtectedResourceMetadata = buildProtectedResourceMetadata({
  resource: MCP_RESOURCE,
  authorizationServers: [AUTH_ISSUER],
  scopesSupported: SCOPES_SUPPORTED,
});
const serveMcpAgent = WebhookMcp.serve("/mcp");

interface DepsHandle {
  readonly deps: ResourceHandlerDeps;
  close(): Promise<void>;
}

/**
 * Build the per-request resource-server deps: the two-validator verifyBearer (the `whk_` api-key chain
 * over the webhook_authn cold path + KV cache, plus opaque-token introspection over AUTH_ISSUER), the PRM
 * doc, and the McpAgent hand-off. One short-lived authn client (the api-key cold lookup), torn down by
 * close(); the pepper is decoded in-worker (Workers secret, never process env). The tenant client used by
 * the tools is opened INSIDE the Durable Object per call (mcp-agent.ts), not here. Mirrors apps/api/buildDeps.
 */
async function buildResourceDeps(env: McpEnv): Promise<DepsHandle> {
  const [pepper, sessionKeyRaw] = await Promise.all([
    readSecretBinding(env.CREDENTIAL_PEPPER),
    readSecretBinding(env.MCP_SESSION_KEY),
  ]);
  const hasher = createCredentialHasherFromBase64(pepper);
  const sessionKey = await importSessionKey(b64ToBytes(sessionKeyRaw));
  const authn = createClient(env.HYPERDRIVE_AUTHN.connectionString, { max: 1 });
  const apiKey = makeApiKeyAuthDeps({
    hasher,
    authn,
    cache: kvCredentialCache(env.KV_AUTHZ),
    resource: MCP_RESOURCE,
  });
  // The opaque-token validator introspects over the AUTH_ISSUER service binding; it's only invoked for a
  // non-`whk_` token, so a `whk_` request never touches the binding.
  const introspectVerify = makeIntrospectVerifyBearer({
    introspect: (token) => env.AUTH_ISSUER.introspect(token),
  });
  const verifyBearer = makeResourceVerifyBearer({
    apiKeyVerify: apiKey.verifyBearer,
    introspectVerify,
  });
  const deps: ResourceHandlerDeps = {
    authDeps: {
      verifyBearer,
      resource: MCP_RESOURCE,
      resourceMetadataUrl: `${MCP_RESOURCE}${PRM_PATH}`,
    },
    resourceMetadata: RESOURCE_METADATA,
    prmPath: PRM_PATH,
    serveMcp: (request, serveEnv, ctx) =>
      serveMcpAgent.fetch(request, serveEnv as McpEnv, ctx as ExecutionContext),
    // The McpAgent reads the principal off the execution context at session init (the same contract the
    // OAuthProvider used: it set `ctx.props` before invoking the apiHandler).
    setProps: (ctx, props) => {
      (ctx as { props?: unknown }).props = props;
    },
    // A8c — bind/open the session id to the principal so a reused id can't reach another principal's DO.
    bindSession: async (assignedId, principal) =>
      bindSessionId(sessionKey, assignedId, await principalDigest(principal)),
    unbindSession: async (presentedId, principal) =>
      unbindSessionId(sessionKey, presentedId, await principalDigest(principal)),
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };
  return { deps, close: () => authn.end() };
}

export default {
  async fetch(request: Request, env: McpEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Public, DB-free routes — served before any deps are built (hot, unauthenticated). The resource
    // handler also serves these so it stays self-contained + unit-tested; this short-circuit just spares
    // them the per-request credential deps. Everything else routes through the resource handler.
    if (request.method === "GET" && url.pathname === PRM_PATH) {
      return Response.json(RESOURCE_METADATA);
    }
    if (request.method === "GET" && url.pathname === HEALTH_PATH) {
      return new Response("mcp ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // buildResourceDeps is inside the try so a config/connection fault returns a graceful 500 (not an
    // escaping throw — incl. an operational verifyBearer fault, which propagates here, never a masked 401).
    let handle: DepsHandle | undefined;
    try {
      handle = await buildResourceDeps(env);
      return await handleResourceRequest(handle.deps, request, env, ctx);
    } catch (err) {
      console.log(JSON.stringify({ message: "mcp.unhandled", error: String(err) }));
      return new Response("internal error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } finally {
      await handle?.close();
    }
  },
} satisfies ExportedHandler<McpEnv>;
