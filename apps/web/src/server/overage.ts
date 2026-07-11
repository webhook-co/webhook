import "server-only";

import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { setOverageEnabled } from "@webhook-co/db/overage-policy";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey, getFreeEventCap, getIngestCacheEvictor } from "./env";

// The overage opt-in toggle orchestration (WS3). setOverageEnabled flips org_limits.pause_policy AND durably
// reconciles ingest_paused in ONE DB tx (owner/admin-gated + audited), so enforcement is correct the instant
// it commits. This layer then asks the engine to evict the org's ingest KV cache so the flip is picked up on
// the next cold miss instead of at the cache TTL — but ONLY as a freshness optimization: the durable state is
// already right, so a missing/failing/slow eviction can never leave the org ingesting past its cap. Never
// throws: faults fold into a status.

export type OverageToggleResult =
  | { readonly status: "ok"; readonly enabled: boolean }
  /** Not an owner/admin — a policy change is admin-only (SEC-RLS-08). */
  | { readonly status: "forbidden" }
  /** No paid plan (no org_limits row) — a Free org can't opt into overage billing. */
  | { readonly status: "no_subscription" }
  | { readonly status: "error" };

/** Cap the best-effort cache-eviction RPC so a hung engine can't hang the toggle's server action — the
 *  durable flip already committed, so timing out here just leaves the cache to its TTL. */
const EVICT_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("evict timeout")), ms)),
  ]);
}

/**
 * Set whether usage past the org's included volume is billed as overage (`enabled` → pause_policy 'allow').
 * @param userId the acting user (audited as the actor + gated for owner/admin membership).
 */
export async function applyOverageToggle(
  orgId: string,
  userId: string,
  enabled: boolean,
): Promise<OverageToggleResult> {
  try {
    // Resolve the audit key BEFORE opening the pool (a fail-closed getAuditChainKey must not strand a pool).
    const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    const result = await withTenantDb((app) =>
      setOverageEnabled(app, auditKey, {
        orgId,
        userId,
        enabled,
        now: Date.now(),
        defaultEventCap: getFreeEventCap(),
      }),
    );
    if (result.status === "forbidden") return { status: "forbidden" };
    if (result.status === "no_subscription") return { status: "no_subscription" };

    // The durable pause state changed → refresh the engine's ingest KV cache so the flip is seen on the next
    // cold miss. Purely best-effort: a missing binding (dev/preview, or a prod provisioning gap), an engine
    // fault, or a timeout only delays cache freshness (TTL-backstopped) — the durable ingest_paused row is
    // already correct, so this can never surface as a failed save.
    if (result.transitioned) {
      const evictor = getIngestCacheEvictor();
      if (evictor) {
        try {
          await withTimeout(evictor.evictOrgIngestCache(orgId), EVICT_TIMEOUT_MS);
        } catch (error) {
          logActionError("billing.overage_evict_failed", error);
        }
      } else {
        logActionError(
          "billing.overage_evict_unbound",
          new Error("INGEST_CACHE_EVICTOR binding absent — ingest cache refreshes at its TTL"),
        );
      }
    }
    return { status: "ok", enabled };
  } catch (error) {
    logActionError("billing.overage_toggle_failed", error);
    return { status: "error" };
  }
}
