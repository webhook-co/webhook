import type { Sql } from "./client";
import {
  clearFreeCapGrace,
  findOwnersOverFreeCap,
  flagOrgForFreeCapGrace,
  listFreeCapManagedOrgs,
  remindOrgForFreeCap,
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
//   active, in grace    → wait; then at T-`reminderMs` REMIND once (slice 4b) — a second, independently-sent
//                         notice, because the drain is at-most-once and one lost warning = a silent suspend.
//   active, past grace   → SUSPEND (reads + delivery held, ingest paused) + email the owners.
//   suspended            → leave it (the owner must upgrade/delete/reassign to resolve).
// Suspension is NOT an expiry: a suspended org can be restored at any time, forever. 0083 carried a
// `restore_deadline` column for a hard-delete slice that was never built; nothing ever read it, and it
// produced two rounds of false copy before 0087 dropped it. Do not reintroduce a deadline without its reader.
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
   * How long BEFORE the grace deadline to send the reminder — the "T-7" in a 14-day window. Not a second
   * deadline: it only picks when the second notice goes out. Must be < graceMs (asserted at the call), or the
   * reminder fires on the pass right after the flag and buys no redundancy.
   */
  readonly reminderMs: number;
  /**
   * The reminder's FLOOR: don't send one with less than this much time left. A reminder is only worth sending
   * if the reader can still act on it — "you'll be suspended on <date>" landing an hour before the suspension
   * email is worse than sending nothing, because it reads as though there's still time. Reachable whenever
   * the cron gaps across the reminder window, or the reminder threw for a run of passes. Must be < reminderMs
   * (asserted at the call).
   */
  readonly minReminderLeadMs: number;
  /**
   * Structured sink for per-org failures. REQUIRED, not optional: without it a swallowed error takes the org
   * id and the reason with it, and `errors: N` alone gives an operator nothing to act on. Mirrors the
   * retention prune's `log` dep.
   */
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

export interface FreeOrgCapReconcileResult {
  readonly flagged: number;
  /** T-7 reminders sent this pass (slice 4b) — the second, independent notice before a suspension. */
  readonly reminded: number;
  readonly suspended: number;
  readonly restored: number;
  readonly graceCleared: number;
  /** Orgs whose step threw and was skipped, across every phase. Each is also `log`ged with its id + reason. */
  readonly errors: number;
  /** Orgs this pass tried to act on, across every phase. */
  readonly attempted: number;
  /**
   * attempted/errors PER PHASE, never pooled. The phases touch different tables and grants and so fail
   * independently — `suspend` alone reaches `ingest_paused`, `flag`/`remind`/`suspend` all reach
   * `notification_intents`, `undo` reaches neither — and any pooled ratio lets a healthy phase mask a wholly
   * broken one. That is not hypothetical: pooling enforce+undo let one successful restore hide a dead flag
   * loop, and then pooling remind+suspend into "enforce" re-created it a level down (a reminder is due on
   * ~168 hourly passes per org versus one for its suspend, so remind successes would swamp the suspend
   * ratio and a total suspend outage would score "partial" forever). See {@link isTotalFreeOrgCapFailure}.
   */
  readonly phases: Readonly<Record<EnforcePhase | "undo", PhaseCounters>>;
}

export interface PhaseCounters {
  readonly attempted: number;
  readonly errors: number;
}

/** The work an ACTIVE overflow org can be owed. `undo` (restore/clear) is tracked alongside these. */
export type EnforcePhase = "flag" | "remind" | "suspend";

/**
 * Did EVERY org in ANY ONE phase fail? The caller throws on this so the cron's error path fires and alerting
 * sees it (the retention prune's `isTotalRetentionFailure` precedent).
 *
 * Why this exists: per-org isolation stops one bad org aborting the pass, but on its own it converts a
 * DETERMINISTIC failure — a regressed grant, a rolled-back migration — into an INFO line shaped exactly like a
 * healthy no-op pass, while the cap goes 100% unenforced every hour, forever.
 *
 * Why PER-PHASE rather than pooled: see {@link FreeOrgCapReconcileResult.phases}. Each phase is judged alone,
 * so a phase that is wholly dead escalates even when every other phase is perfectly healthy.
 *
 * A partial failure within a phase deliberately does NOT escalate: the healthy orgs' work is valid and each
 * failure is logged individually. A phase that attempted nothing is not a failure.
 */
export function isTotalFreeOrgCapFailure(r: FreeOrgCapReconcileResult): boolean {
  return Object.values(r.phases).some((p) => p.attempted > 0 && p.errors === p.attempted);
}

/**
 * What (if anything) an ACTIVE overflow org is owed right now. Pure, so the lifecycle's ordering is testable
 * without a database. Null = in grace with the reminder not yet due — leave it alone.
 *
 * The order matters: `suspend` outranks `remind`, so an org whose deadline has already passed is suspended
 * rather than reminded about a deadline that is behind it (reachable whenever the cron is delayed or the
 * reminder send failed for a whole window).
 */
export function enforcePhase(
  org: Pick<OverCapFreeOrg, "graceUntil" | "remindedAt">,
  now: number,
  reminderMs: number,
  minReminderLeadMs: number,
): EnforcePhase | null {
  if (org.graceUntil === null) return "flag";
  const deadline = org.graceUntil.getTime();
  if (now >= deadline) return "suspend";
  if (org.remindedAt !== null) return null; // already reminded → wait for the deadline
  // BOUNDED ON BOTH SIDES. Above: not before the window opens. Below: not once the deadline is too close to
  // act on — a reminder landing an hour before the suspension email is worse than none, since it implies
  // time that isn't there. Missing the window means no reminder at all; the suspension notice is then the
  // honest thing they get.
  const inWindow = now >= deadline - reminderMs && now <= deadline - minReminderLeadMs;
  return inWindow ? "remind" : null;
}

export async function runFreeOrgCapReconcile(
  reconciler: Sql,
  opts: FreeOrgCapReconcileOptions,
): Promise<FreeOrgCapReconcileResult> {
  const { now, cap, graceMs, reminderMs, minReminderLeadMs, log } = opts;
  // Fail loud on a mis-ordered config rather than silently degrading. reminderMs >= graceMs makes the
  // reminder due on the pass right after the flag (two near-identical notices minutes apart, redundancy
  // gone); minReminderLeadMs >= reminderMs closes the window entirely (no reminder, ever). Both are
  // programming errors in the caller's constants, and both are invisible in the counters — `reminded: 0`
  // reads exactly like a quiet hour — so they must throw where they're introduced, not be discovered later.
  if (!(reminderMs < graceMs)) {
    throw new Error(`free-org-cap: reminderMs (${reminderMs}) must be < graceMs (${graceMs})`);
  }
  if (!(minReminderLeadMs < reminderMs)) {
    throw new Error(
      `free-org-cap: minReminderLeadMs (${minReminderLeadMs}) must be < reminderMs (${reminderMs})`,
    );
  }

  // The overflow set: for every over-cap owner, the orgs BEYOND the oldest `cap` (the ones to disable).
  const overflow = new Map<string, OverCapFreeOrg>();
  for (const owner of await findOwnersOverFreeCap(reconciler, cap)) {
    for (const org of owner.freeOrgs.slice(cap)) overflow.set(org.orgId, org);
  }

  let flagged = 0;
  let reminded = 0;
  let suspended = 0;
  let restored = 0;
  let graceCleared = 0;
  const phases: Record<EnforcePhase | "undo", { attempted: number; errors: number }> = {
    flag: { attempted: 0, errors: 0 },
    remind: { attempted: 0, errors: 0 },
    suspend: { attempted: 0, errors: 0 },
    undo: { attempted: 0, errors: 0 },
  };

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
    const phase = enforcePhase(org, now, reminderMs, minReminderLeadMs);
    if (phase === null) continue; // in grace, reminder not due → nothing to do, nothing attempted
    phases[phase].attempted++;
    try {
      if (phase === "flag") {
        if (await flagOrgForFreeCapGrace(reconciler, org.orgId, new Date(now + graceMs), cap))
          flagged++;
      } else if (phase === "remind") {
        if (await remindOrgForFreeCap(reconciler, org.orgId, cap)) reminded++;
      } else if (await suspendOrgForFreeCap(reconciler, org.orgId, cap)) {
        suspended++;
      }
    } catch (e) {
      phases[phase].errors++; // retried next pass; the rest of the pass — esp. the undo loop — proceeds
      log("free_org_cap.enforce_failed", { orgId: org.orgId, phase, error: String(e) });
    }
  }

  // Reconcile the inverse: orgs we manage that are no longer overflow (owner resolved the overage) → undo.
  for (const managed of await listFreeCapManagedOrgs(reconciler)) {
    if (overflow.has(managed.orgId)) continue; // still overflow → leave as-is
    if (managed.status !== "suspended" && managed.graceUntil === null) continue; // nothing to undo
    phases.undo.attempted++;
    try {
      if (managed.status === "suspended") {
        if (await restoreOrgFromFreeCap(reconciler, managed.orgId)) restored++;
      } else {
        await clearFreeCapGrace(reconciler, managed.orgId);
        graceCleared++;
      }
    } catch (e) {
      phases.undo.errors++;
      log("free_org_cap.undo_failed", {
        orgId: managed.orgId,
        phase: managed.status === "suspended" ? "restore" : "clear_grace",
        error: String(e),
      });
    }
  }

  const all = Object.values(phases);
  return {
    flagged,
    reminded,
    suspended,
    restored,
    graceCleared,
    errors: all.reduce((n, p) => n + p.errors, 0),
    attempted: all.reduce((n, p) => n + p.attempted, 0),
    phases,
  };
}
