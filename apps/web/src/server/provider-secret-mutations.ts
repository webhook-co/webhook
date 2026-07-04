import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { credentialCacheKey } from "@webhook-co/db/credential";
import { getEndpointIngestTokenHash } from "@webhook-co/db/endpoints";
import {
  registerProviderSecret,
  revokeProviderSecret,
  type AddedProviderSecret,
} from "@webhook-co/db/provider-secrets";
import type { Provider, ProviderSecretKind, SecretSealer } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { kvCredentialCache } from "@webhook-co/shared/kv-cache";

import { getTenantDb } from "./db";
import { getAuditChainKey, getProviderSecretSealer } from "./env";

// The provider-secret add/revoke orchestration — the session counterpart of api/mcp's provider-secret
// management handlers, one level up from the shared `registerProviderSecret` write core. Each runs under
// withTenant(orgId) as webhook_app (RLS-scoped by the session orgId; any org member may manage). A provider
// secret is the inbound-VERIFICATION material (a Stripe webhook secret, a Meta verify token, …): it is
// WRITE-ONLY — sealed by the engine's seal-only `PROVIDER_SECRET_SEALER` RPC (the KEK never enters the web
// worker) and never revealed, echoed, or logged after submit. The write core resolves the endpoint (NOT_FOUND
// before any seal), validates the (provider, kind, secret) shape, enforces the per-endpoint cap, serializes
// by kind, seals + inserts + audits, and evicts the endpoint's ingest-token hash from KV_CONFIG so the new
// secret is honored on the NEXT ingest. Revoke flips the row + audits, then best-effort evicts so a signature
// made with the revoked secret stops verifying now rather than after the KV TTL. Mirrors
// replay-destination-mutations (the proven Slice 2 seam).

/** Raised when a seal is attempted without the engine seal binding — fail closed, never store plaintext. */
export class SealerUnavailableError extends Error {
  constructor() {
    super("PROVIDER_SECRET_SEALER is not configured");
    this.name = "SealerUnavailableError";
  }
}

/** Fail-closed sealer guard: an add must never proceed (and store an unsealed/plaintext secret) without it. */
export function requireSealer(sealer: SecretSealer | undefined): SecretSealer {
  if (!sealer) throw new SealerUnavailableError();
  return sealer;
}

export interface AddSecretInput {
  readonly orgId: string;
  readonly endpointId: string;
  readonly provider: Provider;
  readonly kind: ProviderSecretKind;
  /** The RAW plaintext secret as the operator typed it — serialized by kind + sealed in the write core. */
  readonly secret: string;
  readonly label?: string;
  readonly actor: string;
}

export interface RevokeSecretInput {
  readonly orgId: string;
  readonly endpointId: string;
  readonly secretId: string;
  readonly actor: string;
}

/**
 * Injectable boundaries for the glue unit tests; the default binds live env + the sealer RPC + the shared
 * write core over the per-request tenant pool + the KV_CONFIG evictor. Tests inject a stub so the security
 * order in the write core (resolve → validate → cap → seal) is exercised by packages/db's own tests, and
 * this seam's tests exercise only the wiring + the fail-closed sealer guard.
 */
export interface ProviderSecretDeps {
  add(input: AddSecretInput): Promise<AddedProviderSecret>;
  /** Revoke + best-effort evict; null → NOT_FOUND (unknown / cross-org / already-revoked / wrong-endpoint). */
  revoke(input: RevokeSecretInput): Promise<{ id: string; revokedAt: Date } | null>;
}

/** Best-effort KV_CONFIG eviction (mirrors endpoint-mutations'): a failure is scrubbed-logged + swallowed. */
async function evictBestEffort(
  cache: { delete(key: string): Promise<void> } | null,
  tokenHash: Buffer,
  verb: "add" | "revoke",
): Promise<void> {
  if (cache === null) {
    // KV_CONFIG is bound in prod (wrangler + overlay) — a null here means a binding regression. Surface it
    // LOUDLY (never a secret) instead of a silent skip; the durable stop is the DB read + the KV TTL.
    console.warn(JSON.stringify({ message: "provider_secret.evict_skipped_no_kv", verb }));
    return;
  }
  try {
    await cache.delete(credentialCacheKey(tokenHash));
  } catch (err) {
    const e = err as { name?: string };
    console.warn(JSON.stringify({ message: "provider_secret.evict_failed", verb, name: e?.name }));
  }
}

async function defaultDeps(): Promise<{ deps: ProviderSecretDeps; close: () => Promise<void> }> {
  // Resolve the audit key BEFORE opening the pool (a fail-closed getAuditChainKey must not strand an open
  // pool on its error path), exactly as endpoint-mutations does. The sealer is resolved eagerly too so a
  // missing binding fails closed at the first add (via requireSealer) rather than after a partial write.
  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  const sealer = getProviderSecretSealer();
  // Resolve the env via the ASYNC getCloudflareContext (same form getTenantDb + endpoint-mutations use) so
  // the KV_CONFIG binding resolves reliably in the server-action phase — the sync accessor can be
  // unavailable there, silently yielding no cache.
  const { env } = await getCloudflareContext({ async: true });
  const kv = (env as Record<string, unknown>).KV_CONFIG as
    Parameters<typeof kvCredentialCache>[0] | undefined;
  const cache = kv ? kvCredentialCache(kv) : null;
  const app = await getTenantDb();
  return {
    deps: {
      add: (input) =>
        registerProviderSecret(
          app,
          {
            orgId: input.orgId,
            endpointId: input.endpointId,
            provider: input.provider,
            kind: input.kind,
            secret: input.secret,
            label: input.label,
          },
          {
            // Fail-closed: requireSealer throws SealerUnavailableError before any DB touch when unbound.
            sealer: requireSealer(sealer),
            evict: (tokenHash) => evictBestEffort(cache, tokenHash, "add"),
            auditKey,
            actor: input.actor,
          },
        ),
      revoke: async (input) => {
        const revoked = await revokeProviderSecret(
          app,
          { orgId: input.orgId, endpointId: input.endpointId, secretId: input.secretId },
          { auditKey, actor: input.actor },
        );
        if (!revoked) return null;
        // The revoked secret rides on the endpoint's KV verify snapshot until evicted — bust it now so a
        // signature made with it stops verifying immediately (best-effort over the DB source of truth). The
        // revoke is ALREADY committed+audited, so the hash lookup that FEEDS the evict must also be
        // best-effort: a transient failure here must NOT reject a committed revoke (which would report a
        // false failure and prompt a retry that then hits NOT_FOUND). Mirror the api handler.
        const tokenHash = await getEndpointIngestTokenHash(
          app,
          input.orgId,
          input.endpointId,
        ).catch((err: unknown) => {
          console.log(
            JSON.stringify({
              message: "provider_secret.revoke_evict_lookup_failed",
              error: String(err),
            }),
          );
          return null;
        });
        if (tokenHash) await evictBestEffort(cache, tokenHash, "revoke");
        return revoked;
      },
    },
    close: async () => {
      await app.end({ timeout: 5 }).catch(() => {});
    },
  };
}

async function run<T>(
  injected: ProviderSecretDeps | undefined,
  fn: (deps: ProviderSecretDeps) => Promise<T>,
): Promise<T> {
  const { deps, close } = injected
    ? { deps: injected, close: async () => {} }
    : await defaultDeps();
  try {
    return await fn(deps);
  } finally {
    await close();
  }
}

/**
 * Register an endpoint's provider (inbound-verification) secret. The shared write core resolves the endpoint
 * (NOT_FOUND before any seal), validates the (provider, kind, secret) shape, enforces the per-endpoint cap,
 * serializes by kind, seals + inserts + audits, and evicts. Throws a `CapabilityFault` (NOT_FOUND /
 * VALIDATION_ERROR / RATE_LIMITED) — the action maps it — or `SealerUnavailableError` when the seal binding
 * is missing. Returns metadata only ({id, provider, status}); the secret is sealed, never returned or logged.
 */
export function addSecret(
  input: AddSecretInput,
  injected?: ProviderSecretDeps,
): Promise<AddedProviderSecret> {
  return run(injected, (deps) => deps.add(input));
}

/**
 * Revoke an endpoint's provider secret (status → 'revoked') + audit, then best-effort evict the endpoint's
 * ingest-token hash from KV_CONFIG so the verify path stops honoring it now. Returns null → NOT_FOUND
 * (unknown / cross-org / already-revoked / belongs to a different endpoint).
 */
export function revokeSecret(
  input: RevokeSecretInput,
  injected?: ProviderSecretDeps,
): Promise<{ id: string; revokedAt: Date } | null> {
  return run(injected, (deps) => deps.revoke(input));
}
