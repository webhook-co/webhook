import {
  BILLING_ACTIVE_STATUSES,
  formatAuditActor,
  isLiveSubscriptionStatus,
  type AuditActorInput,
} from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql, type TenantTx } from "./client";
import type { FreeOrgCapSuspendedContext, FreeOrgCapWarningContext } from "./delivery";

// personalOrgId is imported for isPersonalOrg's use here AND re-exported through this leaf so the web
// dashboard (which imports leaf subpaths, not the barrel — Turbopack) can resolve the deterministic
// personal-org id alongside deleteOrgWithAudit / isOrgOwner. A bare `export … from` re-export would NOT
// bind the name in this module's scope, so it must be imported to be callable here.
import { listUserOrgs, personalOrgId, type OrgStatus } from "./orgs";

export { personalOrgId };

/**
 * Thrown when an org delete targets a row that doesn't exist in the caller's RLS context — i.e.
 * the org is already gone. Callers translate this to a 404; the transaction has rolled back, so
 * no audit row or purge job is left behind.
 */
export class OrgNotFoundError extends Error {
  constructor(readonly orgId: string) {
    super(`org ${orgId} not found for deletion`);
    this.name = "OrgNotFoundError";
  }
}

/**
 * Is `userId` an OWNER of `orgId`? Membership is access control: RLS only proves a lookup is scoped
 * to the context org, never that the caller may perform owner-only actions — so destructive
 * org-level operations (org delete, erasure) MUST gate on this. Mirrors `isOrgMember` (orgs.ts),
 * narrowed to the `owner` role.
 */
export async function isOrgOwner(app: Sql, userId: string, orgId: string): Promise<boolean> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ one: number }[]>`
        select 1 as one from memberships
        where org_id = ${orgId} and user_id = ${userId} and role = 'owner' limit 1`,
  );
  return rows.length > 0;
}

/** How many members an org has, and how many of them are owners — the input to the last-owner guard. */
export interface OrgMembershipCensus {
  readonly owners: number;
  readonly total: number;
}

/**
 * Count the org's members and how many hold the `owner` role. Runs under the org's RLS context like
 * isOrgOwner, with an EXPLICIT `org_id` predicate — RLS policies are permissive/OR'd, so a future policy
 * could widen the visible set; never lean on RLS alone for a count (see readMembershipRole's warning).
 */
export async function readOrgMembershipCensus(
  app: Sql,
  orgId: string,
): Promise<OrgMembershipCensus> {
  const [row] = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ owners: string; total: string }[]>`
        select
          count(*) filter (where role = 'owner') as owners,
          count(*) as total
        from memberships
        where org_id = ${orgId}`,
  );
  return { owners: Number(row?.owners ?? 0), total: Number(row?.total ?? 0) };
}

/**
 * Would removing this org's SOLE owner orphan it — leave members with no owner? True iff there is exactly
 * one owner and at least one other member. A zero-owner org is a trap: it can never be deleted again
 * (isOrgOwner is false for everyone, so deleteOrgWithAudit can't be called), its failure alerts go nowhere
 * (notifier's owner LEFT JOIN finds none), and its Stripe subscription runs on with no one able to manage
 * it. So a sole owner must transfer ownership before they can leave. A SOLO org (the owner is the only
 * member) is safe — nothing is orphaned. This is the guard's whole decision, kept pure for testing.
 */
export function lastOwnerWouldOrphan(census: OrgMembershipCensus): boolean {
  return census.owners === 1 && census.total > 1;
}

export interface OwnedOrg {
  readonly orgId: string;
  readonly name: string;
}

export interface OwnedOrgClassification {
  /**
   * Orgs this user SOLELY owns that have OTHER members. Deleting their account would leave each of these
   * with zero owners: unreachable by RLS forever, still billed, and its failure alerts going nowhere. The
   * caller must REFUSE and tell them to transfer ownership first.
   */
  readonly wouldOrphan: OwnedOrg[];
  /**
   * Orgs this user solely owns with NOBODY else in them. These are safe to erase alongside the account —
   * and MUST be, or they'd be left with no members at all (an even more complete orphan: still billed, and
   * not even a stranded human to notice).
   */
  readonly soleOwnedSolo: OwnedOrg[];
}

/**
 * Classify every org the user OWNS by what deleting their account would do to it (Lane 2.1b).
 *
 * The 2.1 guard could only census the user's PERSONAL org, because RLS made a cross-org "which orgs do I
 * own?" query impossible for webhook_app — and that was complete only while no shared org could exist. It
 * isn't anymore: invites are live, an owner may invite ANOTHER OWNER, and an owner may then step down. So a
 * user can be the sole owner of an org that is NOT their own — and the identity delete in step 2 of
 * deleteAccount cascades memberships GLOBALLY, orphaning it.
 *
 * 2.4a's user_org_directory (via listUserOrgs) is what makes this answerable at all. The per-org census then
 * runs under each org's OWN tenant context, where RLS lets us see that org's full membership.
 */
export async function classifyOwnedOrgs(app: Sql, userId: string): Promise<OwnedOrgClassification> {
  const owned = (await listUserOrgs(app, userId)).filter((o) => o.role === "owner");

  const wouldOrphan: OwnedOrg[] = [];
  const soleOwnedSolo: OwnedOrg[] = [];
  for (const org of owned) {
    const census = await readOrgMembershipCensus(app, org.orgId);
    if (census.owners !== 1) continue; // another owner remains — leaving orphans nothing
    const entry = { orgId: org.orgId, name: org.name };
    if (census.total > 1) wouldOrphan.push(entry);
    else soleOwnedSolo.push(entry);
  }
  return { wouldOrphan, soleOwnedSolo };
}

/**
 * Does the current tenant org have a subscription in an ENTITLED status — i.e. is it a PAID org? This
 * is the single definition of "paid vs Free", the same status set effectiveBillingPeriod uses to pick
 * the billing-cycle basis over the Free lifetime basis. Callers run it inside the org's tenant context
 * (RLS pins `billing_subscriptions` to the current org). Shared so the free-org cap and the billing
 * period can never drift to two different definitions of entitlement.
 */
export async function hasEntitledSubscription(tx: TenantTx): Promise<boolean> {
  const rows = await tx<{ one: number }[]>`
    select 1 as one from billing_subscriptions
    where status = any(string_to_array(${BILLING_ACTIVE_STATUSES.join(",")}, ',')) limit 1`;
  return rows.length > 0;
}

/**
 * Count the FREE organizations a user owns, for the free-org creation cap. "Free" = the org has no
 * entitled subscription (hasEntitledSubscription). Paid orgs are unlimited, so are never counted.
 *
 * Attribution counts EVERY org the user owns that is Free — NOT only sole-owned ones. An earlier
 * version skipped co-owned orgs (to avoid one co-owner's quota consuming another's), but that was a
 * trivial cap BYPASS: a farmer could add a single throwaway co-owner to every org so `owners !== 1`
 * and the org counted toward nobody, minting unlimited Free allowances. Counting per-owner closes that
 * hole; a co-owned org counts toward each owner, which is defensible because ownership is only ever
 * gained by ACCEPTING an invite. (Downgrade-overflow and the check-then-create race are handled by the
 * authoritative periodic reconciler, not this best-effort creation-time gate.)
 *
 * Runs as webhook_app: listUserOrgs under the user GUC (the only RLS-legal cross-org enumeration, via
 * user_org_directory), then a per-org entitlement read under each org's OWN tenant context.
 */
export async function countOwnedFreeOrgs(app: Sql, userId: string): Promise<number> {
  const owned = (await listUserOrgs(app, userId)).filter((o) => o.role === "owner");

  let free = 0;
  for (const org of owned) {
    const paid = await withTenant(app, org.orgId, (tx) => hasEntitledSubscription(tx));
    if (!paid) free += 1;
  }
  return free;
}

/** One FREE org owned by a user who is over the free-org cap (from {@link findOwnersOverFreeCap}). */
export interface OverCapFreeOrg {
  readonly orgId: string;
  /** The org's birth time — the reconciler keeps the OLDEST `cap` and suspends the rest by default. */
  readonly createdAt: Date;
  /** Its current service state, so the reconciler can skip an org already suspended for this reason. */
  readonly status: OrgStatus;
  readonly suspendedReason: string | null;
  /** Its grace deadline, if flagged — the reconciler suspends once `now >= graceUntil`. Null = not flagged. */
  readonly graceUntil: Date | null;
  /** When the T-7 reminder was sent for the CURRENT grace window. Null = still owed (or not flagged). */
  readonly remindedAt: Date | null;
}

/** A user who owns MORE than the cap allows, with ALL their owned free orgs (oldest-first). */
export interface OverCapOwner {
  readonly userId: string;
  readonly freeOrgs: readonly OverCapFreeOrg[];
}

/**
 * The AUTHORITATIVE free-org-cap detector: across ALL users, every owner of more than `cap` FREE orgs, with
 * each of their owned free orgs (oldest-first). This is the cross-user question the creation-time gate cannot
 * ask and the per-tenant roles cannot answer.
 *
 * Pass the RECONCILER's client (a {@link DB_ROLES.capReconciler} connection): the cross-org read relies on the
 * role-targeted `..._capreconciler_select` policies (migration 0084) that ONLY that role has. A request-path
 * (webhook_app) client sees only its own org, so the same query returns nothing for it — the cross-user reach
 * is confined to this role by RLS, not merely by not calling it.
 *
 * "Free" mirrors {@link countOwnedFreeOrgs}/`hasEntitledSubscription` exactly (no ACTIVE-status subscription),
 * and every owned free org counts (a co-owned one counts for each owner) — the same attribution that closes
 * the sockpuppet-co-owner bypass. The active-status set comes from `BILLING_ACTIVE_STATUSES` (single source,
 * passed in via `string_to_array` so it can't drift). Orders each owner's free orgs oldest-first so the
 * reconciler can keep the oldest `cap` and suspend the rest by default.
 */
export async function findOwnersOverFreeCap(reconciler: Sql, cap: number): Promise<OverCapOwner[]> {
  const rows = await reconciler<
    {
      user_id: string;
      org_id: string;
      org_created_at: Date;
      status: OrgStatus;
      suspended_reason: string | null;
      grace_until: Date | null;
      reminded_at: Date | null;
    }[]
  >`
    with owned_free as (
      select m.user_id,
             o.id as org_id,
             o.created_at as org_created_at,
             o.status,
             o.suspended_reason,
             o.free_org_cap_grace_until as grace_until,
             o.free_org_cap_reminded_at as reminded_at
        from memberships m
        join orgs o on o.id = m.org_id
       where m.role = 'owner'
         and not exists (
           select 1 from billing_subscriptions b
            where b.org_id = o.id
              and b.status = any(string_to_array(${BILLING_ACTIVE_STATUSES.join(",")}, ','))
         )
    )
    select user_id, org_id, org_created_at, status, suspended_reason, grace_until, reminded_at
      from owned_free
     where user_id in (
       select user_id from owned_free group by user_id having count(*) > ${cap}
     )
     order by user_id, org_created_at asc, org_id asc`;

  // Group by owner, PRESERVING the function's oldest-first ordering (Map keeps insertion order, and the rows
  // arrive ordered by (user_id, org_created_at)).
  const byUser = new Map<string, OverCapFreeOrg[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({
      orgId: r.org_id,
      createdAt: r.org_created_at,
      status: r.status,
      suspendedReason: r.suspended_reason,
      graceUntil: r.grace_until,
      remindedAt: r.reminded_at,
    });
    byUser.set(r.user_id, list);
  }
  return [...byUser].map(([userId, freeOrgs]) => ({ userId, freeOrgs }));
}

/** An org the free-org-cap reconciler currently MANAGES — suspended for the cap, or flagged in its grace
 *  window. Used to find orgs to RESTORE/clear once their owner is no longer over the cap. */
export interface FreeCapManagedOrg {
  readonly orgId: string;
  readonly status: OrgStatus;
  readonly graceUntil: Date | null;
}

/**
 * Every org the reconciler is currently acting on: suspended for `free_org_cap`, OR flagged with a grace
 * deadline. Read as the reconciler (cross-org). The reconcile pass compares this against the CURRENT overflow
 * set — a managed org NOT in that set means the owner resolved the overage (upgraded/deleted/reassigned), so
 * it must be restored (if suspended) or un-flagged (if in grace).
 */
export async function listFreeCapManagedOrgs(reconciler: Sql): Promise<FreeCapManagedOrg[]> {
  // No `reminded_at` here on purpose: the undo loop decides on status + grace alone, and carrying a field
  // its consumer never reads would invite the next reader to assume reminded-ness gates an undo. It doesn't.
  // `OverCapFreeOrg.remindedAt` — which enforcePhase actually consumes — is the only place it belongs.
  const rows = await reconciler<{ org_id: string; status: OrgStatus; grace_until: Date | null }[]>`
    select id as org_id, status, free_org_cap_grace_until as grace_until
      from orgs
     where (status = 'suspended' and suspended_reason = 'free_org_cap')
        or free_org_cap_grace_until is not null`;
  return rows.map((r) => ({ orgId: r.org_id, status: r.status, graceUntil: r.grace_until }));
}

// ── The free-org-cap reconciler's WRITE side (migration 0085) ────────────────────────────────────────────
//
// These run as the RECONCILER client (webhook_capreconciler) and act CROSS-ORG — no withTenant, because the
// role's role-targeted UPDATE policies (`..._capreconciler_*`) grant it that reach, and there is no tenant GUC
// to set. Each targets one org by id; the column grants fence the writes to the suspend-lifecycle fields.

/**
 * upsert ingest_paused for one org as the reconciler. On pause, reason becomes `free_org_cap` — necessarily
 * OVERWRITING any prior reason (e.g. an event-cap `'cap'` pause). That overwrite is required, not incidental:
 * the cap producer's non-clobber keys on `reason='free_org_cap'` to know it must not resume a suspended org,
 * so a suspended org's pause MUST carry that reason.
 *
 * The consequence, and why it's acceptable: an org paused for BOTH its event cap AND the free-org cap loses
 * the `'cap'` marker while suspended, so on RESTORE the un-pause below fires even if it's still over its event
 * cap. That is bounded and SELF-HEALING — the very next cap-producer pass (≤ its cron interval) re-pauses it
 * with `reason='cap'`. It only affects Free orgs (no paid-overage revenue path), and only the rare org over
 * both caps at once. Making it exact would require the reconciler to read usage/limits, which is deliberately
 * outside its least-privilege grant.
 */
async function setIngestPausedFreeCap(tx: TenantTx, orgId: string, paused: boolean): Promise<void> {
  if (paused) {
    await tx`
      insert into ingest_paused (org_id, paused, reason, since, updated_at)
      values (${orgId}, true, 'free_org_cap', now(), now())
      on conflict (org_id) do update
        set paused = true, reason = 'free_org_cap', since = now(), updated_at = now()`;
  } else {
    // Lift ONLY a pause we own (reason='free_org_cap'). A row left at reason='cap' by the cap producer is not
    // ours to resume — leave it (an org over its event cap must stay paused).
    await tx`
      update ingest_paused
         set paused = false, reason = null, since = null, updated_at = now()
       where org_id = ${orgId} and reason = 'free_org_cap'`;
  }
}

/**
 * Enqueue a free-org-cap notification intent AS THE RECONCILER (PR2b slice 4, migration 0086).
 *
 * Not {@link insertNotificationIntent}: that one takes a TenantTx (it runs under webhook_app's per-org RLS
 * and reads back the new id via RETURNING). The reconciler is tenant-GUC-less and, by design, holds INSERT on
 * notification_intents but NOT SELECT — so RETURNING would be a permission error, and the id is unused here
 * anyway. `status` is likewise ungranted: the row can only ever be born 'pending' via the column default,
 * which is exactly the property that stops this path from minting a pre-'sent' (i.e. silenced) notification.
 */
async function enqueueFreeCapIntent(
  tx: TenantTx,
  orgId: string,
  kind: "free_org_cap_warning" | "free_org_cap_reminder" | "free_org_cap_suspended",
  context: FreeOrgCapWarningContext | FreeOrgCapSuspendedContext,
): Promise<void> {
  await tx`
    insert into notification_intents (id, org_id, kind, destination_id, context)
    values (${crypto.randomUUID()}, ${orgId}, ${kind}, ${null},
            ${tx.json(context as unknown as Record<string, string | number | null>)})`;
}

/**
 * Flag an ACTIVE, not-yet-flagged org as over the free-org cap, starting its grace window, and warn its
 * owners. Leaves the org active (reads + delivery + ingest all continue) — this only records the deadline the
 * cron will suspend at if the overage isn't resolved first.
 *
 * IDEMPOTENT ON THE DEADLINE: the `free_org_cap_grace_until is null` guard means re-flagging an
 * already-flagged org is a NO-OP — the FIRST flag's deadline stands. This is load-bearing: the 3b cron's
 * natural query is "flag everything currently over cap", so it re-flags the same org every pass; without this
 * guard each pass would push the deadline forward and suspension would never fire. To reset a deadline, clear
 * it first ({@link clearFreeCapGrace}) then flag. Also a no-op (0 rows) if the org isn't active.
 *
 * The warning intent is enqueued IN THE SAME tx as the flag, and ONLY when the flag actually took (the
 * `returning id` guard) — so the re-flag no-op cannot re-send the warning every hour for the whole grace
 * window, and a flag can never commit un-announced.
 */
export async function flagOrgForFreeCapGrace(
  reconciler: Sql,
  orgId: string,
  graceUntil: Date,
  cap: number,
): Promise<boolean> {
  return reconciler.begin(async (tx) => {
    // Clears `free_org_cap_reminded_at` as it OPENS the window, not just on the paths that close one.
    // Reminded-ness belongs to a grace window, and this is where a window begins — so resetting it here is
    // what actually makes the invariant hold, rather than relying on every closer remembering to. Without
    // it, any writer that nulls `grace_until` alone (an ops fix-up, a future lifecycle path) strands a
    // stamped `reminded_at`, and the org's NEXT grace window silently skips its reminder — leaving that
    // owner one notice on an at-most-once pipeline, which is the exact failure this slice exists to prevent.
    const rows = await tx<{ id: string }[]>`
      update orgs
         set free_org_cap_grace_until = ${graceUntil},
             free_org_cap_reminded_at = null
       where id = ${orgId} and status = 'active' and free_org_cap_grace_until is null
      returning id`;
    if (rows.length === 0) return false; // already flagged, or not active → don't re-warn
    await enqueueFreeCapIntent(tx, orgId, "free_org_cap_warning", {
      graceUntilIso: graceUntil.toISOString(),
      cap,
    });
    return true;
  });
}

/**
 * Clear an org's grace flag — the user resolved the overage (upgraded/deleted/reassigned) in time.
 *
 * Clears `free_org_cap_reminded_at` alongside it: reminded-ness is a property OF a grace window, not of the
 * org. Leaving it set would mean an org that goes over cap again months later gets its warning but never its
 * T-7 reminder — silently losing half the notice redundancy, in the case (a repeat offender) where it matters
 * most. The two fields are set and cleared together, always.
 */
export async function clearFreeCapGrace(reconciler: Sql, orgId: string): Promise<void> {
  await reconciler`
    update orgs set free_org_cap_grace_until = null, free_org_cap_reminded_at = null
     where id = ${orgId}`;
}

/**
 * The T-7 reminder (slice 4b): a SECOND notice partway through the grace window, for an org still flagged and
 * still not reminded. Stamps `free_org_cap_reminded_at` and enqueues the reminder intent atomically.
 *
 * Why this exists at all: the warning rides an at-most-once drain (claimed pending→sent BEFORE the Resend
 * call), so a single 5xx loses it forever and the org is suspended in silence. Two independently-sent notices
 * mean no single send failure can swallow the notice entirely. It is redundancy, not nagging.
 *
 * FIRES EXACTLY ONCE per grace window: the `free_org_cap_reminded_at is null` guard makes the cron's natural
 * "remind everything in the reminder window" query idempotent — same shape, and same reason, as the flag's
 * `free_org_cap_grace_until is null` guard. Also a no-op if the org isn't active or isn't flagged (a
 * suspension or a resolved overage both overtake the reminder).
 */
export async function remindOrgForFreeCap(
  reconciler: Sql,
  orgId: string,
  cap: number,
): Promise<boolean> {
  return reconciler.begin(async (tx) => {
    const rows = await tx<{ grace: Date }[]>`
      update orgs set free_org_cap_reminded_at = now()
       where id = ${orgId}
         and status = 'active'
         and free_org_cap_grace_until is not null
         and free_org_cap_reminded_at is null
      returning free_org_cap_grace_until as grace`;
    const grace = rows[0]?.grace;
    if (grace === undefined) return false; // not active / not flagged / already reminded → don't re-send
    // The deadline comes from the ROW, not the caller: the reminder must state the deadline the suspend will
    // actually act on, and the flag that set it may have been many passes ago.
    await enqueueFreeCapIntent(tx, orgId, "free_org_cap_reminder", {
      graceUntilIso: grace.toISOString(),
      cap,
    });
    return true;
  });
}

/**
 * Suspend an over-cap org: mark it suspended (gates reads + delivery), pause its ingest, AND tell its owners
 * — atomically. Only acts on a currently-ACTIVE org (so a re-run never re-stamps suspended_at, nor re-sends
 * the email). Returns true iff it suspended.
 */
export async function suspendOrgForFreeCap(
  reconciler: Sql,
  orgId: string,
  cap: number,
): Promise<boolean> {
  return reconciler.begin(async (tx) => {
    // No restore deadline is stamped: 0087 dropped that column. A cap-suspended org can be restored at any
    // time — nothing expires it — and the emails say so by saying nothing.
    const rows = await tx<{ id: string }[]>`
      update orgs
         set status = 'suspended',
             suspended_reason = 'free_org_cap',
             suspended_at = now(),
             free_org_cap_grace_until = null,
             free_org_cap_reminded_at = null
       where id = ${orgId} and status = 'active'
      returning id`;
    if (rows.length === 0) return false; // wasn't active → nothing suspended
    await setIngestPausedFreeCap(tx, orgId, true);
    await enqueueFreeCapIntent(tx, orgId, "free_org_cap_suspended", { cap });
    return true;
  });
}

/**
 * Restore an org suspended for the free-org cap: back to active, suspend metadata cleared, ingest un-paused
 * (only the free_org_cap pause — an event-cap pause is left to the cap producer). Only acts on an org
 * currently suspended FOR free_org_cap. Returns true iff it restored.
 *
 * Held deliveries are NOT woken here: they stayed durably owed while suspended, and the existing hourly
 * DELIVERY reconciler re-wakes any idle DO with due work — so a restored org's backlog drains within the hour
 * without this path needing DO access (the reconciler role has none). The return value is for the caller's
 * metrics/logging.
 */
export async function restoreOrgFromFreeCap(reconciler: Sql, orgId: string): Promise<boolean> {
  return reconciler.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      update orgs
         set status = 'active',
             suspended_reason = null,
             suspended_at = null,
             free_org_cap_grace_until = null,
             free_org_cap_reminded_at = null
       where id = ${orgId} and status = 'suspended' and suspended_reason = 'free_org_cap'
      returning id`;
    if (rows.length === 0) return false; // wasn't free_org_cap-suspended → nothing restored
    await setIngestPausedFreeCap(tx, orgId, false);
    return true;
  });
}

/**
 * Is `orgId` a PERSONAL org — the deterministic identity-home org of one of its own owners? Decided
 * from the org's OWN membership, NOT from who is asking: an org is personal iff some owner `u` has
 * `personalOrgId(u) === orgId`. Keying the "can't delete the personal org" guard on the caller instead
 * (orgId === personalOrgId(callerId)) would let a SECOND owner of someone's personal org delete it —
 * erasing their identity home and re-opening the Free-allowance recycle on their next sign-in. So the
 * guard must ask this org-centric question. Runs under the org's tenant context (RLS-scoped memberships).
 */
export async function isPersonalOrg(app: Sql, orgId: string): Promise<boolean> {
  const owners = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ userId: string }[]>`
        select user_id as "userId" from memberships where org_id = ${orgId} and role = 'owner'`,
  );
  return owners.some((o) => personalOrgId(o.userId) === orgId);
}

/**
 * Hard-delete an org and all of its Postgres metadata (every `org_id` child table is
 * `ON DELETE CASCADE`), while PRESERVING the two append-only WORM audit trails — `audit_log` and
 * `auth_audit_event` had their `orgs` FK decoupled in migration 0051, so the cascade no longer
 * fires their row-level `no_delete` triggers (which would abort the whole delete) and their
 * tamper-evident, R2-anchored, pseudonymous history survives. Captured payload BODIES live in R2,
 * outside Postgres, so they are not cascaded here: a durable purge job is enqueued in
 * `org_deletions` and drained by the engine's `webhook_purge` cron.
 *
 * Runs as `webhook_app` under RLS pinned to `orgId`. AUTHZ is the caller's responsibility: verify
 * the principal is an owner (`isOrgOwner`) BEFORE calling — RLS proves the caller is *in* the org,
 * never that they may delete it.
 */
export async function deleteOrgWithAudit(
  app: Sql,
  input: { orgId: string; actor: AuditActorInput },
  auditKey: CryptoKey,
): Promise<{ orgId: string; deletedAt: string }> {
  return withTenant(app, input.orgId, async (tx) => {
    // Close out the tamper-evident chain first. audit_log has no FK to orgs (0051), so this row
    // survives the delete below — and if the delete finds nothing, the throw rolls the whole
    // transaction back, leaving no orphan audit row or purge job.
    await appendAuditEntry(tx, auditKey, {
      orgId: input.orgId,
      actor: input.actor,
      action: "org.deleted",
      target: input.orgId,
    });
    // Enqueue the durable R2 payload-body purge (also FK-free, so it outlives the org row). The
    // insert `with check (org_id = current_org_id())` is why a tenant can't forge another org's job.
    // `requested_by` keeps the encoding it ALREADY has. This column (0051) holds bare user ids for every org
    // deleted before today, and there is no migration to rewrite them — so writing the prefixed `user:<id>`
    // form here would leave one column carrying two incompatible encodings, and a lookup of "who requested
    // this deletion" would silently find nothing for exactly the rows we meant to attribute. A user actor
    // therefore still writes its bare id (org deletion is only ever a web session action today). A non-user
    // actor writes the prefixed form, which cannot collide with a bare id and cannot pre-exist. The purge
    // role deliberately cannot read this column at all (0051).
    const requestedBy =
      input.actor.kind === "user" ? input.actor.id : formatAuditActor(input.actor);
    await tx`
      insert into org_deletions (org_id, requested_by)
      values (${input.orgId}, ${requestedBy})`;
    // Capture the org's live Stripe subscription BEFORE the delete cascades billing_subscriptions
    // away, and enqueue a cancellation the apps/api cron drains against Stripe. Without this a paying
    // customer who deletes their account (or a paid org) keeps being charged forever, and the row that
    // would let anyone reconcile it is gone. Canceling inline is unsafe (this delete is one of a loop of
    // separate transactions + a cross-worker RPC): a cancel-then-DB-fail would leave a live org with a
    // canceled subscription, which effectiveBillingPeriod drops to the exhausted Free lifetime basis and
    // the cap producer then PAUSES the payer's ingest. webhook_app has tenant-scoped SELECT on
    // billing_subscriptions; only a subscription that still EXISTS at Stripe (isLiveSubscriptionStatus)
    // needs canceling — a canceled/expired one is a no-op. `on conflict` keeps a re-delete idempotent.
    // The explicit org_id predicate is defense-in-depth beyond RLS (same reasoning as
    // readOrgMembershipCensus above): RLS policies are permissive/OR'd, so a future policy must never be
    // able to widen this read into another tenant's subscription id.
    const [sub] = await tx<{ stripeSubscriptionId: string; status: string }[]>`
      select stripe_subscription_id as "stripeSubscriptionId", status
      from billing_subscriptions where org_id = ${input.orgId}`;
    if (sub && isLiveSubscriptionStatus(sub.status)) {
      await tx`
        insert into org_billing_cancellations (org_id, stripe_subscription_id)
        values (${input.orgId}, ${sub.stripeSubscriptionId})
        on conflict (org_id) do nothing`;
    }
    // Hard-delete: every org_id child cascades; the two WORM audit tables + org_deletions persist.
    const [row] = await tx<{ deletedAt: string }[]>`
      delete from orgs where id = ${input.orgId} returning now()::text as "deletedAt"`;
    if (!row) {
      throw new OrgNotFoundError(input.orgId);
    }
    return { orgId: input.orgId, deletedAt: row.deletedAt };
  });
}

/** One outstanding R2-purge job: the deleted org and where its last purge pass left off. */
export interface PurgeJob {
  orgId: string;
  /** The R2 list cursor to resume from, or null to (re)start at the beginning of the prefix. */
  cursor: string | null;
}

/**
 * Read outstanding R2-purge jobs (oldest first) for the engine drain. Runs as `webhook_purge` on
 * its own connection (NOT `withTenant`) — the role-targeted `FOR SELECT TO webhook_purge` policy is
 * the sole bound, so this is a bare cross-org read of a table the role can only see, never mutate
 * beyond its column-scoped UPDATE. The `partial index on (requested_at) where status='purging'`
 * keeps the scan index-driven.
 */
export async function claimPurgeJobs(purge: Sql, limit: number): Promise<PurgeJob[]> {
  return purge<PurgeJob[]>`
    select org_id as "orgId", r2_cursor as cursor
    from org_deletions
    where status = 'purging'
    order by requested_at
    limit ${limit}`;
}

/**
 * Advance a purge job after a batch of R2 objects was deleted. When `done`, the prefix is exhausted:
 * flip the job to `completed` and stamp `purge_completed_at` (its durable proof the payloads are
 * gone). Otherwise persist the resume `cursor` and accumulate the count so the next drain tick (or a
 * crash-retry) picks up exactly where this left off. Runs as `webhook_purge`; the `status='purging'`
 * predicate + the role-targeted UPDATE policy mean a completed job is never touched again.
 */
export async function advancePurgeJob(
  purge: Sql,
  input: { orgId: string; cursor: string | null; deltaObjects: number; done: boolean },
): Promise<void> {
  if (input.done) {
    await purge`
      update org_deletions
      set objects_purged = objects_purged + ${input.deltaObjects},
          r2_cursor = null,
          status = 'completed',
          purge_completed_at = now()
      where org_id = ${input.orgId} and status = 'purging'`;
    return;
  }
  await purge`
    update org_deletions
    set objects_purged = objects_purged + ${input.deltaObjects},
        r2_cursor = ${input.cursor}
    where org_id = ${input.orgId} and status = 'purging'`;
}
