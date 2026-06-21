import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { credentialCacheKey } from "@webhook-co/db/credential";
import {
  revokeApiKey as dbRevokeApiKey,
  revokeGrant as dbRevokeGrant,
} from "@webhook-co/db/grants";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";

import { getTenantDb } from "./db";
import { getAuditChainKey } from "./env";

/**
 * The DB + KV operations a revoke needs. Lane B stamps `revoked_at` (+ writes the audit) and returns the
 * key hash(es); the dashboard must then **evict** each from the shared KV_AUTHZ cache via
 * `cache.delete(credentialCacheKey(hash))` so a revoked key stops authenticating immediately (KV is a
 * read-through cache shared across api/mcp/engine). Injected for tests; the default binds the real
 * `webhook_app` pool + audit key + the KV_AUTHZ namespace.
 */
export interface RevokeDeps {
  revokeKey(orgId: string, keyId: string, userId: string): Promise<{ keyHash: Buffer | null }>;
  revokeGrant(
    orgId: string,
    grantId: string,
    userId: string,
  ): Promise<{ revokedKeyHashes: readonly Buffer[] }>;
  evict(keyHash: Buffer): Promise<void>;
}

async function defaultDeps(): Promise<{ deps: RevokeDeps; close: () => Promise<void> }> {
  const { env } = await getCloudflareContext({ async: true });
  // Resolve the audit key + cache BEFORE opening the pool: getAuditChainKey() fails closed in prod (and a
  // malformed base64 throws), so opening the pool first would leak it on that error path. getTenantDb() is
  // the last fallible call before the return, so nothing after it can strand an open pool.
  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  const cache = kvCredentialCache(
    (env as Record<string, unknown>).KV_AUTHZ as Parameters<typeof kvCredentialCache>[0],
  );
  const app = await getTenantDb();
  return {
    deps: {
      revokeKey: (orgId, keyId, userId) =>
        dbRevokeApiKey(app, { orgId, keyId, revokedBy: userId }, auditKey),
      revokeGrant: (orgId, grantId, userId) =>
        dbRevokeGrant(app, { orgId, grantId, revokedBy: userId }, auditKey),
      evict: (keyHash) => cache.delete(credentialCacheKey(keyHash)),
    },
    close: async () => {
      await app.end({ timeout: 5 }).catch(() => {});
    },
  };
}

/**
 * Best-effort eviction over the TTL-bounded read-through cache. A revoke is **durable** the moment Lane B
 * stamps `revoked_at`; evicting KV_AUTHZ merely accelerates it (otherwise the entry lapses within the
 * credential-cache TTL). So an eviction failure is logged (scrubbed — opaque id + counts only, never the
 * key hash/plaintext) and **swallowed**: it must not turn a committed revoke into a reported failure, which
 * would both mislead the operator and strand the cache (a retry's DB revoke is a no-op that returns no hash,
 * so the stale entry could never be re-evicted). `allSettled` so one flaky delete never abandons the rest.
 */
async function evictBestEffort(
  deps: RevokeDeps,
  hashes: readonly Buffer[],
  ctx: { kind: "key" | "grant"; id: string },
): Promise<void> {
  if (hashes.length === 0) return;
  const settled = await Promise.allSettled(hashes.map((hash) => deps.evict(hash)));
  const failed = settled.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    console.warn(
      JSON.stringify({
        message: "credential.cache_evict_incomplete",
        kind: ctx.kind,
        [`${ctx.kind}Id`]: ctx.id,
        failed,
        total: hashes.length,
      }),
    );
  }
}

/** Revoke a standalone key + evict it from KV_AUTHZ. No-op eviction if nothing was revoked (RLS / already-revoked). */
export async function revokeKeyById(
  input: { orgId: string; userId: string; keyId: string },
  injected?: RevokeDeps,
): Promise<void> {
  const { deps, close } = injected
    ? { deps: injected, close: async () => {} }
    : await defaultDeps();
  try {
    const { keyHash } = await deps.revokeKey(input.orgId, input.keyId, input.userId);
    if (keyHash) await evictBestEffort(deps, [keyHash], { kind: "key", id: input.keyId });
  } finally {
    await close();
  }
}

/** Revoke a grant (cascades to its keys) + evict EVERY cascaded key hash from KV_AUTHZ. */
export async function revokeGrantById(
  input: { orgId: string; userId: string; grantId: string },
  injected?: RevokeDeps,
): Promise<void> {
  const { deps, close } = injected
    ? { deps: injected, close: async () => {} }
    : await defaultDeps();
  try {
    const { revokedKeyHashes } = await deps.revokeGrant(input.orgId, input.grantId, input.userId);
    await evictBestEffort(deps, revokedKeyHashes, { kind: "grant", id: input.grantId });
  } finally {
    await close();
  }
}
