// Notification delivery (S3 Slice 3 PR3c-3). The engine's auto-disable queues a `notification_intents` row
// (migration 0032) but can't send mail — no identity-email read, no Resend binding. The auth. worker's cron
// closes the loop. This module is the db half, run on a webhook_notifier connection (the caller passes a
// notifier-scoped postgres.js client): that role's role-targeted policies + column grants grant the cross-org
// read/mark WITHOUT a BYPASSRLS bypass. There is no withTenant and no tenant GUC — the drain spans all orgs.
//
// ORDERING CONTRACT (PR3c-3b): the drain must CLAIM-then-send — `read → markNotificationSent (claim) → send`,
// NOT read→send→mark. markNotificationSent is single-flight, so under two overlapping cron passes exactly one
// claims each intent and only that pass sends → at-most-once. A crash between claim and send loses at most one
// email (acceptable: the destination is already disabled and the owner sees it in the dashboard); the
// alternative (send-then-mark) would double-send on any overlap. An intent with NO deliverable owner (see
// below) is surfaced with an empty `ownerEmails` so the drain can claim it — clearing it from the pending
// backlog — without sending anything.

import type { Sql } from "./client";

/** A pending notification resolved to its recipients — one row per intent, with every org OWNER's email. */
export interface PendingNotification {
  readonly intentId: string;
  readonly orgId: string;
  readonly kind: string;
  /** The destination the notification is about (nullable for future, destination-less kinds). */
  readonly destinationId: string | null;
  /** Every owner of the org (an org can have several) — the email is sent to all of them. */
  readonly ownerEmails: string[];
}

/** Default per-drain cap. Intents are rare (a destination auto-disable), so this is generous headroom. */
export const DEFAULT_NOTIFY_LIMIT = 100;

/**
 * The notifier's hot read: pending intents resolved to each org's OWNER email(s), oldest first. Cross-org via
 * the webhook_notifier role's role-targeted SELECT policies (notification_intents + memberships) plus a table
 * grant on the global, RLS-exempt `user` identity table for the address. The email links to the dashboard by
 * destination id, so no destination URL / delivery content is read.
 *
 * The owner join is a LEFT JOIN on purpose: an intent whose org has NO resolvable owner (e.g. the sole
 * owner's account was deleted, cascading the membership away) is still returned — with an EMPTY `ownerEmails`
 * — so the drain can claim + clear it instead of leaving it to accumulate in the pending index forever. The
 * caller sends nothing for an empty recipient list.
 */
export async function listPendingNotifications(
  sql: Sql,
  limit = DEFAULT_NOTIFY_LIMIT,
): Promise<PendingNotification[]> {
  // Bound the LIMIT to distinct pending INTENTS (the inner query) then expand to one row per owner — so a
  // multi-owner org never eats extra limit slots, and the owner emails are aggregated in JS rather than a
  // delimiter-joined SQL string (an email's quoted local-part can legally contain a comma, so string-splitting
  // would mis-parse it). The role's SELECT policies apply inside the subquery just the same.
  const rows = await sql<
    {
      id: string;
      org_id: string;
      kind: string;
      destination_id: string | null;
      created_at: Date;
      email: string | null;
    }[]
  >`
    select ni.id, ni.org_id, ni.kind, ni.destination_id, ni.created_at, u.email
    from (
      select id, org_id, kind, destination_id, created_at
      from notification_intents
      where status = 'pending'
      order by created_at
      limit ${limit}
    ) ni
    left join memberships m on m.org_id = ni.org_id and m.role = 'owner'
    left join "user" u on u.id = m.user_id
    order by ni.created_at, ni.id, u.email`;
  // Group the flat (intent × owner) rows back into one entry per intent, preserving created_at order. A
  // LEFT JOIN yields a single row with a null email for an ownerless intent → an empty ownerEmails.
  const byIntent = new Map<string, PendingNotification>();
  for (const r of rows) {
    let entry = byIntent.get(r.id);
    if (!entry) {
      entry = {
        intentId: r.id,
        orgId: r.org_id,
        kind: r.kind,
        destinationId: r.destination_id,
        ownerEmails: [],
      };
      byIntent.set(r.id, entry);
    }
    if (r.email !== null) entry.ownerEmails.push(r.email);
  }
  return [...byIntent.values()];
}

/**
 * CLAIM one intent by flipping it pending → sent (stamping sent_at). Single-flight: the `status = 'pending'`
 * guard means only the first caller to win the row lock flips it — a concurrent claim of the same row blocks,
 * re-checks under READ COMMITTED, sees status='sent', and matches zero rows. Returns whether THIS call won the
 * claim (false = already claimed by an overlapping drain). The drain calls this BEFORE sending (see the module
 * ORDERING CONTRACT), so exactly one pass sends each intent's email. The webhook_notifier UPDATE policy bounds
 * this to pending rows (USING status='pending') and to setting status='sent' (WITH CHECK) on (status, sent_at).
 */
export async function markNotificationSent(sql: Sql, intentId: string): Promise<boolean> {
  const res = await sql`
    update notification_intents set status = 'sent', sent_at = now()
    where id = ${intentId} and status = 'pending'`;
  return res.count === 1;
}
