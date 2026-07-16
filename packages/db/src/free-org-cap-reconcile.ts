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
//   active, past grace   → SUSPEND (reads + delivery held, ingest paused) + email the owners.
//   suspended            → leave it (the owner must upgrade/delete/reassign to resolve).
// Suspension is NOT an expiry: `restore_deadline` is stamped but read by nothing, so a suspended org can be
// restored at any time, forever — which is what the emails and the /suspended screen say.
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
  /**
   * Window (ms) stamped onto a suspended org's `restore_deadline`. WRITE-ONLY as of today: nothing reads that
   * column — `restoreOrgFromFreeCap` gates on status + reason alone, no prune consults it, and neither user
   * surface cites it — so it bounds nothing and no deadline is enforced. 0083 reserved it for "a later slice
   * hard-deletes past it"; until that slice exists, do not describe it as informational-for-the-UI (it isn't
   * surfaced) and do not let copy present it as an expiry.
   */
  readonly restoreMs: number;
  /**
   * Structured sink for per-org failures. REQUIRED, not optional: without it a swallowed error takes the org
   * id and the reason with it, and `errors: N` alone gives an operator nothing to act on. Mirrors the
   * retention prune's `log` dep.
   */
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

export interface FreeOrgCapReconcileResult {
  readonly flagged: number;
  readonly suspended: number;
  readonly restored: number;
  readonly graceCleared: number;
  /** Orgs whose step threw and was skipped, across both loops. Each is also `log`ged with its id + reason. */
  readonly errors: number;
  /** Orgs this pass tried to act on, across both loops. */
  readonly attempted: number;
  /**
   * Per-loop attempted/errors, kept SEPARATE because the two loops fail independently and pooling them hides
   * an outage: with one ratio, a deterministic total ENFORCE failure (a regressed 0086 grant → every
   * enqueue throws) is scored "partial" on any hour where a single unrelated restore succeeds, and never
   * escalates. See {@link isTotalFreeOrgCapFailure}.
   */
  readonly enforce: { readonly attempted: number; readonly errors: number };
  readonly undo: { readonly attempted: number; readonly errors: number };
}

/**
 * Did EVERY org in EITHER loop fail? The caller throws on this so the cron's error path fires and alerting
 * sees it (the retention prune's `isTotalRetentionFailure` precedent).
 *
 * Why this exists: per-org isolation stops one bad org aborting the pass, but on its own it converts a
 * DETERMINISTIC failure — a regressed grant, a rolled-back migration — into an INFO line shaped exactly like a
 * healthy no-op pass, while the cap goes 100% unenforced every hour, forever.
 *
 * Why PER-LOOP rather than pooled: the enforce loop (flag/suspend) and the undo loop (restore/clear) depend on
 * different grants and fail independently. A pooled ratio lets a healthy undo loop mask a totally broken
 * enforce loop — the exact scenario this function exists to catch. Each loop is judged on its own.
 *
 * A partial failure within a loop deliberately does NOT escalate: the healthy orgs' work is valid and each
 * failure is logged individually. A loop that attempted nothing is not a failure.
 */
export function isTotalFreeOrgCapFailure(r: FreeOrgCapReconcileResult): boolean {
  const total = (l: { attempted: number; errors: number }) =>
    l.attempted > 0 && l.errors === l.attempted;
  return total(r.enforce) || total(r.undo);
}

export async function runFreeOrgCapReconcile(
  reconciler: Sql,
  opts: FreeOrgCapReconcileOptions,
): Promise<FreeOrgCapReconcileResult> {
  const { now, cap, graceMs, restoreMs, log } = opts;

  // The overflow set: for every over-cap owner, the orgs BEYOND the oldest `cap` (the ones to disable).
  const overflow = new Map<string, OverCapFreeOrg>();
  for (const owner of await findOwnersOverFreeCap(reconciler, cap)) {
    for (const org of owner.freeOrgs.slice(cap)) overflow.set(org.orgId, org);
  }

  let flagged = 0;
  let suspended = 0;
  let restored = 0;
  let graceCleared = 0;
  const enforce = { attempted: 0, errors: 0 };
  const undo = { attempted: 0, errors: 0 };

  // PER-ORG ISOLATION (both loops): each org's step is independently try/caught, so one org's failure can't
  // abort the pass. This is load-bearing for the UNDO loop below — before, a throw while enforcing any single
  // overflow org (each step now also INSERTs a notification intent, so it depends on a grant on a second
  // table) propagated out of runFreeOrgCapReconcile and the restore loop never ran. A deterministic failure
  // there would strand every already-suspended org as suspended FOREVER, including owners who had already
  // resolved their overage and were waiting to be restored — the worst direction to fail in. Mirrors the
  // sibling retention prune's partial-failure isolation.

  // Enforce each overflow org through the grace → suspend lifecycle. Both writes enqueue their own owner
  // email in-transaction, and both are guarded so a re-run of an already-flagged / already-suspended org
  // neither re-stamps nor re-sends.
  for (const org of overflow.values()) {
    if (org.status === "suspended") continue; // already suspended for the cap → nothing to do
    const due = org.graceUntil === null || now >= org.graceUntil.getTime();
    if (!due) continue; // still within the grace window → leave it active, and don't count it as attempted
    enforce.attempted++;
    try {
      if (org.graceUntil === null) {
        if (await flagOrgForFreeCapGrace(reconciler, org.orgId, new Date(now + graceMs), cap))
          flagged++;
      } else if (
        await suspendOrgForFreeCap(reconciler, org.orgId, new Date(now + restoreMs), cap)
      ) {
        suspended++;
      }
    } catch (e) {
      enforce.errors++; // retried next pass; the rest of the pass — especially the undo loop — proceeds
      log("free_org_cap.enforce_failed", {
        orgId: org.orgId,
        phase: org.graceUntil === null ? "flag" : "suspend",
        error: String(e),
      });
    }
  }

  // Reconcile the inverse: orgs we manage that are no longer overflow (owner resolved the overage) → undo.
  for (const managed of await listFreeCapManagedOrgs(reconciler)) {
    if (overflow.has(managed.orgId)) continue; // still overflow → leave as-is
    if (managed.status !== "suspended" && managed.graceUntil === null) continue; // nothing to undo
    undo.attempted++;
    try {
      if (managed.status === "suspended") {
        if (await restoreOrgFromFreeCap(reconciler, managed.orgId)) restored++;
      } else {
        await clearFreeCapGrace(reconciler, managed.orgId);
        graceCleared++;
      }
    } catch (e) {
      undo.errors++;
      log("free_org_cap.undo_failed", {
        orgId: managed.orgId,
        phase: managed.status === "suspended" ? "restore" : "clear_grace",
        error: String(e),
      });
    }
  }

  return {
    flagged,
    suspended,
    restored,
    graceCleared,
    errors: enforce.errors + undo.errors,
    attempted: enforce.attempted + undo.attempted,
    enforce,
    undo,
  };
}
