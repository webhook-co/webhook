import {
  buildProtectedResourceMetadata,
  type ProtectedResourceMetadata,
} from "@webhook-co/contract";
import {
  createClient,
  createCredentialHasherFromBase64,
  createCredentialResolver,
  createReadHandlers,
  makeApiKeyColdLookup,
  makeVerifyBearer,
} from "@webhook-co/db";
import {
  b64ToBytes,
  importAuditKey,
  importCursorKey,
  readSecretBinding,
  SERVICE_NAME,
} from "@webhook-co/shared";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";

import { handleRequest, type ApiDeps } from "./router.js";

// The api.webhook.co REST read server: a bearer-auth resource server over the contract's read
// capabilities. It validates API keys (OAuth tokens are opaque + mcp-bound, ADR-0010) through the
// injected verifyBearer seam, then dispatches to the SHARED read handlers (packages/db) — the same
// handlers the MCP surface binds, so the surfaces can't drift. Public discovery (RFC 9728 PRM) +
// health are served before any tenant deps are built; every other request builds two short-lived
// DB clients and tears them down in a finally. The routing/auth/mapping live in router.ts (DI,
// node-tested); this file wires the real per-request deps (mirrors apps/engine).

/** Our canonical resource identifier — the RFC 8707 audience API keys are bound to at this surface. */
export const API_RESOURCE = "https://api.webhook.co";
const PRM_PATH = "/.well-known/oauth-protected-resource";
/** The OAuth token issuer for this resource (co-located on mcp.; ADR-0010). */
const TOKEN_ISSUER = "https://mcp.webhook.co";

export interface Env {
  /** webhook_authn Hyperdrive (caching OFF): the api-key cold lookup (org-discovery-by-hash). */
  HYPERDRIVE_AUTHN: Hyperdrive;
  /** Cache-disabled Hyperdrive for authenticated tenant-scoped reads (RLS-gated). */
  HYPERDRIVE_TENANT: Hyperdrive;
  /** KV caching resolved principals (keyed by api-key hash); invalidated on revoke. */
  KV_AUTHZ: KVNamespace;
  /**
   * The payloads bucket (shared with engine, which writes it). The api only ever GETs from it —
   * events.getPayload streams a captured event's stored body after an RLS metadata read (ADR-0015).
   * The binding is a standard R2 binding; read-only is a usage discipline (a scoped token is a future
   * hardening), so never call put/delete here.
   */
  R2_PAYLOADS: R2Bucket;
  // Secrets are Cloudflare Secrets Store bindings (read via `await readSecretBinding(env.X)`); the trio
  // below is ONE account secret each, shared byte-identically with engine + mcp. Never DB columns.
  /** Base64 credential pepper: keys the api-key HMAC (same pepper across surfaces). */
  CREDENTIAL_PEPPER: SecretsStoreSecret;
  /** Base64 HMAC key for opaque pagination cursors (must equal the other surfaces' CURSOR_KEY). */
  CURSOR_KEY: SecretsStoreSecret;
  /** Base64 audit-chain HMAC key — the same key the chain rows are signed with. */
  AUDIT_CHAIN_HMAC_KEY: SecretsStoreSecret;
}

// Built once at module load (pure); served on the public PRM route with no tenant deps.
const RESOURCE_METADATA: ProtectedResourceMetadata = buildProtectedResourceMetadata({
  resource: API_RESOURCE,
  authorizationServers: [TOKEN_ISSUER],
});

interface DepsHandle {
  readonly deps: ApiDeps;
  close(): Promise<void>;
}

/**
 * Build the per-request deps from the Worker bindings: verifyBearer over the KV-cached api-key
 * resolver (webhook_authn cold path), plus the shared read handlers over the tenant binding. Two
 * short-lived clients (authn + tenant), torn down by close(). The pepper/keys are decoded in-worker
 * (Workers secrets, never process env). Mirrors apps/engine/buildIngestDeps.
 */
async function buildDeps(env: Env): Promise<DepsHandle> {
  // Resolve the Secrets Store bindings, then decode + validate ALL config (pepper + keys) BEFORE
  // opening any DB client, so a bad/missing secret fails fast without leaking an unclosed connection.
  const [pepper, cursorRaw, auditRaw] = await Promise.all([
    readSecretBinding(env.CREDENTIAL_PEPPER),
    readSecretBinding(env.CURSOR_KEY),
    readSecretBinding(env.AUDIT_CHAIN_HMAC_KEY),
  ]);
  const hasher = createCredentialHasherFromBase64(pepper);
  const [cursorKey, auditKey] = await Promise.all([
    importCursorKey(b64ToBytes(cursorRaw)),
    importAuditKey(b64ToBytes(auditRaw)),
  ]);
  const authn = createClient(env.HYPERDRIVE_AUTHN.connectionString, { max: 1 });
  const tenant = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
  const resolver = createCredentialResolver({
    hasher,
    cache: kvCredentialCache(env.KV_AUTHZ),
    coldLookup: makeApiKeyColdLookup(authn, API_RESOURCE),
    // Stamp this surface's audience on every resolved principal — KV_AUTHZ is shared with mcp/engine.
    resource: API_RESOURCE,
  });
  const deps: ApiDeps = {
    authDeps: {
      verifyBearer: makeVerifyBearer(resolver),
      resource: API_RESOURCE,
      resourceMetadataUrl: `${API_RESOURCE}${PRM_PATH}`,
    },
    handlers: createReadHandlers({ tenant, cursorKey, auditKey }),
    payloads: env.R2_PAYLOADS,
  };
  return {
    deps,
    close: async () => {
      // Tear down both clients regardless of either's outcome — never leak a pooled connection.
      await Promise.allSettled([authn.end(), tenant.end()]);
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Public, DB-free routes: served before any tenant deps are built.
    if (request.method === "GET" && url.pathname === PRM_PATH) {
      return Response.json(RESOURCE_METADATA);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(`${SERVICE_NAME}:api ok`, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // buildDeps is inside the try so a config/connection fault returns a graceful 500 (not an
    // escaping throw); handle?.close() tolerates buildDeps throwing before it returned a handle.
    let handle: DepsHandle | undefined;
    try {
      handle = await buildDeps(env);
      return await handleRequest(request, handle.deps);
    } catch (err) {
      // A binding/connection fault (bad secret, Hyperdrive down) or an unexpected throw surfaces as
      // a generic 500 — internals go to observability, never to the client.
      console.log(JSON.stringify({ message: "api.unhandled", error: String(err) }));
      return new Response("internal error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } finally {
      await handle?.close();
    }
  },
} satisfies ExportedHandler<Env>;

// The auth seam stays re-exported from the app root for existing consumers.
export { authorize, extractBearer, type ApiAuthDeps, type AuthzResult } from "./auth.js";
