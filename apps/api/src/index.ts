import {
  buildProtectedResourceMetadata,
  type ProtectedResourceMetadata,
} from "@webhook-co/contract";
import {
  API_RESOURCE,
  buildCapabilityHandlers,
  createClient,
  createCredentialHasherFromBase64,
  createReplayHandler,
  makeApiKeyAuthDeps,
  makeIngestHashEvictor,
} from "@webhook-co/db";
import {
  b64ToBytes,
  importAuditKey,
  importCursorKey,
  readSecretBinding,
  type SecretSealer,
  SERVICE_NAME,
} from "@webhook-co/shared";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";

import { handleRequest, type ApiDeps } from "./router.js";
import { handleGithubSecretScanning } from "./secret-scanning.js";

// The api.webhook.co REST read server: a bearer-auth resource server over the contract's read
// capabilities. It validates API keys (OAuth tokens are opaque + mcp-bound, ADR-0010) through the
// injected verifyBearer seam, then dispatches to the SHARED read handlers (packages/db) — the same
// handlers the MCP surface binds, so the surfaces can't drift. Public discovery (RFC 9728 PRM) +
// health are served before any tenant deps are built; every other request builds two short-lived
// DB clients and tears them down in a finally. The routing/auth/mapping live in router.ts (DI,
// node-tested); this file wires the real per-request deps (mirrors apps/engine).

// API_RESOURCE (the RFC 8707 audience this surface binds api keys to) is single-sourced in @webhook-co/db.
const PRM_PATH = "/.well-known/oauth-protected-resource";
/**
 * The OAuth token issuer for this resource — auth.webhook.co (the Lane C issuer). Was mcp. while mcp
 * co-located the issuer (ADR-0010); A8 tore that down (mcp is now a resource server), so api's RFC 9728
 * discovery must point clients at the real issuer. api still validates `whk_` keys directly (zero issuer
 * involvement) — this is discovery metadata only.
 */
const TOKEN_ISSUER = "https://auth.webhook.co";

export interface Env {
  /** webhook_authn Hyperdrive (caching OFF): the api-key cold lookup (org-discovery-by-hash). */
  HYPERDRIVE_AUTHN: Hyperdrive;
  /** Cache-disabled Hyperdrive for authenticated tenant-scoped reads (RLS-gated). */
  HYPERDRIVE_TENANT: Hyperdrive;
  /** KV caching resolved principals (keyed by api-key hash); invalidated on revoke. */
  KV_AUTHZ: KVNamespace;
  /**
   * The engine's ingest-token cache namespace (the SAME KV_CONFIG the engine reads on the wbhk.my hot
   * path). api binds it ONLY to EVICT a token's entry after endpoints.delete / endpoints.rotate
   * (ADR-0076), via makeIngestHashEvictor — never to read/write principals. KV is global-by-id, so this
   * is the same namespace by id (overlay-injected); the delete is keyed by credentialCacheKey(hash).
   */
  KV_CONFIG: KVNamespace;
  /**
   * The payloads bucket (shared with engine, which writes it). The api only ever GETs from it —
   * events.getPayload streams a captured event's stored body after an RLS metadata read (ADR-0015).
   * The binding is a standard R2 binding; read-only is a usage discipline (a scoped token is a future
   * hardening), so never call put/delete here.
   */
  R2_PAYLOADS: R2Bucket;
  /**
   * Seal-only RPC to the engine's ProviderSecretSealer WorkerEntrypoint (B0/ADR-0078, decision D1):
   * endpoints.addProviderSecret seals the plaintext via `env.PROVIDER_SECRET_SEALER.sealString(...)`
   * so api NEVER holds the KEK (it can seal, never unseal). The binding's RPC stub satisfies the
   * write-only SecretSealer interface directly. Deploy-injected by the overlay generator (the engine
   * entrypoint is live from B0 #246) — NOT in the committed wrangler.jsonc, exactly like mcp's AUTH_ISSUER.
   */
  PROVIDER_SECRET_SEALER: SecretSealer;
  // Secrets are Cloudflare Secrets Store bindings (read via `await readSecretBinding(env.X)`); the trio
  // below is ONE account secret each, shared byte-identically with engine + mcp. Never DB columns.
  /** Base64 credential pepper: keys the api-key HMAC (same pepper across surfaces). */
  CREDENTIAL_PEPPER: SecretsStoreSecret;
  /** Base64 HMAC key for opaque pagination cursors (must equal the other surfaces' CURSOR_KEY). */
  CURSOR_KEY: SecretsStoreSecret;
  /** Base64 audit-chain HMAC key — the same key the chain rows are signed with. */
  AUDIT_CHAIN_HMAC_KEY: SecretsStoreSecret;
  /**
   * The cookieless ingest apex the endpoints.create response builds its one-time ingest URL from
   * (prod: https://wbhk.my). A plain wrangler `vars` value (NOT a secret, NOT deploy-injected — the
   * overlay generator carries no `vars`, so it must be committed in wrangler.jsonc). Validated
   * fail-closed by the shared write handler (normalizeIngestApex) lazily AT CREATE TIME — a missing/
   * garbage value 500s only the create path, never minting `undefined/<token>` and never breaking reads.
   */
  INGEST_BASE_URL: string;
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
  const deps: ApiDeps = {
    authDeps: {
      // The api-key bearer chain, single-sourced; resource drives the cold-lookup binding + the
      // audience stamp (KV_AUTHZ is shared with mcp/engine, so one entry per key stays revoke-complete).
      ...makeApiKeyAuthDeps({
        hasher,
        authn,
        cache: kvCredentialCache(env.KV_AUTHZ),
        resource: API_RESOURCE,
      }),
      resourceMetadataUrl: `${API_RESOURCE}${PRM_PATH}`,
    },
    // The merged read+write capability-handler map (single-sourced in @webhook-co/db so apps/mcp builds
    // the identical map and the surfaces can't drift). endpoints.create dispatches through this map; its
    // handler validates INGEST_BASE_URL lazily + fail-closed at create time, so a bad create-only var
    // never breaks these reads (it 500s only the create path).
    handlers: buildCapabilityHandlers({
      tenant,
      cursorKey,
      auditKey,
      hasher,
      ingestBaseUrl: env.INGEST_BASE_URL,
      // endpoints.delete / endpoints.rotate evict the token's hot entry from the engine's ingest cache
      // (ADR-0076). Best-effort: the soft-delete deleted_at filter + the rotated hash mismatch already
      // self-heal within the KV TTL, so a KV blip is logged (never fails the request — which for rotate
      // would lose the one-time URL reveal).
      invalidateIngestHash: makeIngestHashEvictor(kvCredentialCache(env.KV_CONFIG), (err) =>
        console.log(JSON.stringify({ message: "api.ingest_evict_failed", error: String(err) })),
      ),
      // endpoints.addProviderSecret seals via the engine (api never holds the KEK — B0/D1).
      secretSealer: env.PROVIDER_SECRET_SEALER,
    }),
    payloads: env.R2_PAYLOADS,
    replay: createReplayHandler({ tenant }),
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
    // GitHub Secret Scanning Partner Program webhook (ADR-0074). Unauthenticated — the ECDSA
    // signature IS the auth; the handler verifies BEFORE opening any DB client and owns its own
    // teardown, so it sits with the other pre-router branches (not behind the bearer router).
    if (request.method === "POST" && url.pathname === "/secret-scanning/github") {
      try {
        return await handleGithubSecretScanning(request, env);
      } catch (err) {
        console.log(JSON.stringify({ message: "secret_scanning.unhandled", error: String(err) }));
        return new Response("internal error", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
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
