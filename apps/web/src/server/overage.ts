import "server-only";

import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";
import { setOverageEnabled } from "@webhook-co/db/overage-policy";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey, getCapReEvaluator } from "./env";

// The overage opt-in toggle orchestration (WS3). Flips org_limits.pause_policy in the DB (owner/admin-gated
// + audited, in setOverageEnabled), then asks the engine to reconcile enforcement IMMEDIATELY so an over-cap
// org resumes/pauses without waiting for the hourly cron. The DB is the source of truth; the engine RPC is a
// best-effort immediacy optimization and the metering cron is the guaranteed backstop — so a missing/failing
// RPC degrades to eventual (logged), never to an incorrect state. Never throws: faults fold into a status.

export type OverageToggleResult =
  | { readonly status: "ok"; readonly enabled: boolean }
  /** Not an owner/admin — a policy change is admin-only (SEC-RLS-08). */
  | { readonly status: "forbidden" }
  /** No paid plan (no org_limits row) — a Free org can't opt into overage billing. */
  | { readonly status: "no_subscription" }
  | { readonly status: "error" };

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
      setOverageEnabled(app, auditKey, { orgId, userId, enabled }),
    );
    if (result.status === "forbidden") return { status: "forbidden" };
    if (result.status === "no_subscription") return { status: "no_subscription" };

    // The policy actually changed → reconcile enforcement now (resume an over-cap org that just enabled
    // overage, or pause one that disabled it). Best-effort: the ingest_paused row is the source of truth and
    // the hourly cron reconciles regardless, so a missing binding (dev/preview, or a prod provisioning gap)
    // or an engine fault degrades to eventual consistency — logged loudly, never surfaced as a failed save.
    if (result.changed) {
      const reevaluator = getCapReEvaluator();
      if (reevaluator) {
        try {
          await reevaluator.reevaluateOrgCap(orgId);
        } catch (error) {
          logActionError("billing.overage_reeval_failed", error);
        }
      } else {
        logActionError(
          "billing.overage_reeval_unbound",
          new Error(
            "CAP_REEVALUATOR binding absent — enforcement reconciles on the next cron pass",
          ),
        );
      }
    }
    return { status: "ok", enabled };
  } catch (error) {
    logActionError("billing.overage_toggle_failed", error);
    return { status: "error" };
  }
}
