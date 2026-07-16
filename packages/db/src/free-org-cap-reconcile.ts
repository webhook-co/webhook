import type { Sql } from "./client";
import {
  clearFreeCapGrace,
  findOwnersOverFreeCap,
  flagOrgForFreeCapGrace,
  listFreeCapManagedOrgs,
  restoreOrgFromFreeCap,
  suspendOrgForFreeCap,
  type OverCapFreeOrg,
} from "./org-lifecycle";

// The AUTHORITATIVE free-org-cap reconcile pass (PR2b slice 3b). Runs as the reconciler (webhook_capreconciler)
// cross-user; the engine's hourly cron wires the real Hyperdrive client. Pure over its inputs (client + clock)
// so it real-PG tests directly.
//
// The lifecycle of an overflow org, least-harm and never a surprise:
//   active, unflagged   → FLAG a grace deadline + email the owners "suspends on <date>" (slice 4).
//   active, in grace    → wait (nothing happens until the deadline).
//   active, past grace   → SUSPEND (reads + delivery held, ingest paused) + email, with a restore window.
//   suspended            → leave it (the owner must upgrade/delete/reassign to resolve).
// And the inverse: an org the reconciler MANAGES whose owner is no longer over the cap (resolved the overage)
// is RESTORED (if suspended) or un-flagged (if only in grace).
//
// "Overflow" defaults to the NEWEST orgs beyond the oldest `cap` (keep the oldest `cap` active). A later slice
// lets the owner reassign which `cap` stay; until then, oldest-kept is the policy.
//
// Restore does NOT wake delivery DOs here (the reconciler has no destination access): a restored org's held
// deliveries are still durably owed, and the existing hourly DELIVERY reconciler re-wakes any idle DO with due
// work — so a restored org's backlog drains within the hour without this cron touching a DO.

export interface FreeOrgCapReconcileOptions {
  /** Injected wall clock (ms) — deterministic + testable. */
  readonly now: number;
  /** Max FREE orgs a user may own (MAX_FREE_ORGS_PER_USER). Owners over this have their overflow enforced. */
  readonly cap: number;
  /** Grace window (ms) between first flagging an overflow org and suspending it. */
  readonly graceMs: number;
  /** Restore window (ms) written onto a suspended org's `restore_deadline` (informational for the UI/retention). */
  readonly restoreMs: number;
}

export interface FreeOrgCapReconcileResult {
  readonly flagged: number;
  readonly suspended: number;
  readonly restored: number;
  readonly graceCleared: number;
}

export async function runFreeOrgCapReconcile(
  reconciler: Sql,
  opts: FreeOrgCapReconcileOptions,
): Promise<FreeOrgCapReconcileResult> {
  const { now, cap, graceMs, restoreMs } = opts;

  // The overflow set: for every over-cap owner, the orgs BEYOND the oldest `cap` (the ones to disable).
  const overflow = new Map<string, OverCapFreeOrg>();
  for (const owner of await findOwnersOverFreeCap(reconciler, cap)) {
    for (const org of owner.freeOrgs.slice(cap)) overflow.set(org.orgId, org);
  }

  let flagged = 0;
  let suspended = 0;
  let restored = 0;
  let graceCleared = 0;

  // Enforce each overflow org through the grace → suspend lifecycle. Both writes enqueue their own owner
  // email in-transaction, and both are guarded so a re-run of an already-flagged / already-suspended org
  // neither re-stamps nor re-sends.
  for (const org of overflow.values()) {
    if (org.status === "suspended") continue; // already suspended for the cap → nothing to do
    if (org.graceUntil === null) {
      if (await flagOrgForFreeCapGrace(reconciler, org.orgId, new Date(now + graceMs), cap))
        flagged++;
    } else if (now >= org.graceUntil.getTime()) {
      if (await suspendOrgForFreeCap(reconciler, org.orgId, new Date(now + restoreMs), cap))
        suspended++;
    }
    // else: still within the grace window → leave it active
  }

  // Reconcile the inverse: orgs we manage that are no longer overflow (owner resolved the overage) → undo.
  for (const managed of await listFreeCapManagedOrgs(reconciler)) {
    if (overflow.has(managed.orgId)) continue; // still overflow → leave as-is
    if (managed.status === "suspended") {
      if (await restoreOrgFromFreeCap(reconciler, managed.orgId)) restored++;
    } else if (managed.graceUntil !== null) {
      await clearFreeCapGrace(reconciler, managed.orgId);
      graceCleared++;
    }
  }

  return { flagged, suspended, restored, graceCleared };
}
