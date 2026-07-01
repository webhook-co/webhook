import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  createCredentialHasherFromBase64,
  credentialCacheKey,
  type CredentialHasher,
} from "@webhook-co/db/credential";
import {
  createEndpointWithAudit,
  DEFAULT_MAX_ENDPOINTS_PER_ORG,
  deleteEndpointWithAudit,
  rotateEndpointWithAudit,
} from "@webhook-co/db/endpoints";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";

import { getTenantDb } from "./db";
import { getAuditChainKey, getCredentialPepper, getIngestBaseUrl } from "./env";

// The endpoint create/rotate/delete orchestration — the same DB-direct seam the credential dashboard uses
// (mint/revoke), one level up from Lane B's tx-atomic db fns. Each runs under withTenant(orgId) as
// webhook_app (RLS-scoped by the session orgId); create/rotate mint a >=256-bit ingest token and return
// the one-time ingest URL; delete is soft. rotate (hard cut) + delete evict the affected token hash from
// the engine's KV_CONFIG ingest cache so the old URL stops resolving NOW — best-effort over the durable
// db stop (the cold-lookup `deleted_at is null` filter + the 300s TTL self-heal), so a KV blip never fails
// a committed mutation (for rotate that would lose the one-time reveal of the NEW url). It is the session
// counterpart of the api/mcp createWriteHandlers seam: that seam gates on a bearer's `endpoints:write`
// scope, whereas this surface authenticates a SESSION (RLS-org-pinned, any org member may manage), so it
// binds the raw Lane B fns directly under withTenant rather than the scope-gated handler — but reuses the
// shared cap (DEFAULT_MAX_ENDPOINTS_PER_ORG) so the per-org limit can't drift between surfaces.

/**
 * Validate + normalize the configured ingest apex fail-closed to its bare origin BEFORE any mint, so a
 * misconfigured INGEST_BASE_URL throws rather than minting a broken `undefined/<token>` URL. This mirrors
 * packages/db's `normalizeIngestApex` (ADR-0075) by design; it is reimplemented (a pure ~12-line URL
 * validator, no dependency) rather than imported so this module pulls no `@webhook-co/contract` barrel via
 * the write-handlers seam into the Turbopack bundle (see [[turbopack-contract-barrel]]).
 */
export function normalizeIngestApex(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("INGEST_BASE_URL must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("INGEST_BASE_URL must be an absolute http(s) URL");
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new Error("INGEST_BASE_URL must have no path, query, or fragment");
  }
  return url.origin;
}

export interface CreateEndpointInput {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}
export interface MutateEndpointInput {
  readonly orgId: string;
  readonly userId: string;
  readonly endpointId: string;
}

/** A created or rotated endpoint plus its one-time ingest URL (the token is revealed ONCE). */
export interface MintedEndpoint {
  readonly id: string;
  readonly name: string;
  readonly paused: boolean;
  readonly createdAt: Date;
  /** `${apex}/<token>` — shown once, never persisted or logged. */
  readonly ingestUrl: string;
}

/**
 * Injectable boundaries for the glue unit tests; the pure transforms (hasher / audit key / apex) are NOT
 * injected so a test still exercises the real imports (the surface that once bundled to `undefined`).
 * The default binds live env + Lane B over the per-request tenant pool + the KV_CONFIG evictor.
 */
export interface EndpointMutationDeps {
  create(
    orgId: string,
    name: string,
    actor: string,
  ): Promise<{ id: string; name: string; paused: boolean; createdAt: Date; plaintext: string }>;
  rotate(
    orgId: string,
    endpointId: string,
    actor: string,
  ): Promise<{
    id: string;
    name: string;
    paused: boolean;
    createdAt: Date;
    oldTokenHash: Buffer;
    plaintext: string;
  }>;
  remove(orgId: string, endpointId: string, actor: string): Promise<{ tokenHash: Buffer }>;
  /** Best-effort evict of an ingest-token hash from KV_CONFIG; never throws (logs scrubbed + swallows). */
  evict(tokenHash: Buffer, verb: "rotate" | "delete"): Promise<void>;
  apex(): string;
}

/** Best-effort KV_CONFIG eviction (mirrors credential-revoke's): a failure is scrubbed-logged + swallowed. */
async function evictBestEffort(
  cache: { delete(key: string): Promise<void> } | null,
  tokenHash: Buffer,
  ctx: { verb: "rotate" | "delete" },
): Promise<void> {
  if (cache === null) {
    // KV_CONFIG is bound in prod (wrangler + overlay) — a null here means a binding regression. Surface it
    // LOUDLY (the api/mcp write handler fails loud on a missing evictor) instead of a silent skip; the
    // durable stop is still the cold-lookup `deleted_at is null` filter + the 300s TTL self-heal.
    console.warn(
      JSON.stringify({ message: "endpoint.ingest_evict_skipped_no_kv", verb: ctx.verb }),
    );
    return;
  }
  try {
    await cache.delete(credentialCacheKey(tokenHash));
  } catch (err) {
    const e = err as { name?: string };
    console.warn(
      JSON.stringify({ message: "endpoint.ingest_evict_failed", verb: ctx.verb, name: e?.name }),
    );
  }
}

async function defaultDeps(): Promise<{ deps: EndpointMutationDeps; close: () => Promise<void> }> {
  // Resolve the audit key BEFORE opening the pool (a fail-closed getAuditChainKey must not leak an open
  // pool on its error path), exactly as credential-revoke does. getTenantDb() is the last fallible call
  // before return, so nothing after it can strand an open pool.
  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  // Resolve the env via the ASYNC getCloudflareContext (same form getTenantDb + credential-revoke use) so
  // the KV_CONFIG binding resolves reliably in the server-action phase — the sync accessor can be
  // unavailable there, silently yielding no cache.
  const { env } = await getCloudflareContext({ async: true });
  const kv = (env as Record<string, unknown>).KV_CONFIG as
    Parameters<typeof kvCredentialCache>[0] | undefined;
  const cache = kv ? kvCredentialCache(kv) : null;
  const app = await getTenantDb();
  // The hasher (CREDENTIAL_PEPPER fetch → key import) is needed ONLY by create/rotate, which mint a token —
  // NOT by soft-delete. Resolve it lazily + memoized so a delete never does the wasted secret round-trip +
  // WebCrypto key import.
  let hasherP: Promise<CredentialHasher> | undefined;
  const getHasher = () =>
    (hasherP ??= getCredentialPepper().then(createCredentialHasherFromBase64));
  return {
    deps: {
      create: async (orgId, name, actor) => {
        const r = await createEndpointWithAudit(
          app,
          { orgId, name, actor, maxEndpoints: DEFAULT_MAX_ENDPOINTS_PER_ORG },
          await getHasher(),
          auditKey,
        );
        return {
          id: r.id,
          name: r.name,
          paused: r.paused,
          createdAt: r.createdAt,
          plaintext: r.plaintext,
        };
      },
      rotate: async (orgId, endpointId, actor) => {
        const r = await rotateEndpointWithAudit(
          app,
          { orgId, endpointId, actor },
          await getHasher(),
          auditKey,
        );
        return {
          id: r.id,
          name: r.name,
          paused: r.paused,
          createdAt: r.createdAt,
          oldTokenHash: r.oldTokenHash,
          plaintext: r.plaintext,
        };
      },
      remove: async (orgId, endpointId, actor) => {
        const r = await deleteEndpointWithAudit(app, { orgId, endpointId, actor }, auditKey);
        return { tokenHash: r.tokenHash };
      },
      evict: (tokenHash, verb) => evictBestEffort(cache, tokenHash, { verb }),
      apex: () => normalizeIngestApex(getIngestBaseUrl()),
    },
    close: async () => {
      await app.end({ timeout: 5 }).catch(() => {});
    },
  };
}

/**
 * Create an endpoint + mint its ingest token + write the `endpoint.created` audit atomically (Lane B), then
 * return the one-time ingest URL. The plaintext is returned ONCE — never SSR'd, persisted, or logged.
 */
export async function createEndpoint(
  input: CreateEndpointInput,
  injected?: EndpointMutationDeps,
): Promise<MintedEndpoint> {
  const { deps, close } = injected
    ? { deps: injected, close: async () => {} }
    : await defaultDeps();
  try {
    const apex = deps.apex(); // validate BEFORE the mint (fail-closed) — mirrors the db write handler
    const r = await deps.create(input.orgId, input.name, input.userId);
    return {
      id: r.id,
      name: r.name,
      paused: r.paused,
      createdAt: r.createdAt,
      ingestUrl: `${apex}/${r.plaintext}`,
    };
  } finally {
    await close();
  }
}

/**
 * Rotate an endpoint's ingest token IN PLACE (hard cutover) + audit, evict the OLD token hash from KV_CONFIG
 * so the old URL dies now, and return the NEW one-time ingest URL. The evict runs AFTER the committed swap
 * and is best-effort (a throw would lose the one-time reveal); the db is the source of truth.
 */
export async function rotateEndpoint(
  input: MutateEndpointInput,
  injected?: EndpointMutationDeps,
): Promise<MintedEndpoint> {
  const { deps, close } = injected
    ? { deps: injected, close: async () => {} }
    : await defaultDeps();
  try {
    const apex = deps.apex(); // validate BEFORE the mint (mirrors create)
    const r = await deps.rotate(input.orgId, input.endpointId, input.userId);
    await deps.evict(r.oldTokenHash, "rotate");
    return {
      id: r.id,
      name: r.name,
      paused: r.paused,
      createdAt: r.createdAt,
      ingestUrl: `${apex}/${r.plaintext}`,
    };
  } finally {
    await close();
  }
}

/**
 * Soft-delete an endpoint (sets deleted_at; events + payloads retained) + audit, then evict its token hash
 * from KV_CONFIG so ingest stops now. Idempotent at the db; the evict is best-effort over the durable stop.
 */
export async function deleteEndpoint(
  input: MutateEndpointInput,
  injected?: EndpointMutationDeps,
): Promise<void> {
  const { deps, close } = injected
    ? { deps: injected, close: async () => {} }
    : await defaultDeps();
  try {
    const r = await deps.remove(input.orgId, input.endpointId, input.userId);
    await deps.evict(r.tokenHash, "delete");
  } finally {
    await close();
  }
}
