// The free-org-cap notification emails (PR2b slice 4). Two kinds, one shell:
//   free_org_cap_warning   → "this org suspends on <date>, here's how to keep it" (org still fully active)
//   free_org_cap_suspended → "this org is suspended, here's how to get it back"
//
// Pure renderers — the notifier cron wires the send. Same posture as the destination-disabled email:
// self-contained HTML, no tracking, the only remote asset is the brand logo on our own domain.
//
// Unlike the other notification kinds, the org's NAME and SLUG are not in the intent's `context` — the
// producer (webhook_capreconciler) cannot read them. The notifier resolves them at render time and passes
// them in (migration 0086), which is why they arrive as an `org` argument rather than on the context.
//
// SECURITY: `org.name` is user-controlled and reaches BOTH the HTML body and the SUBJECT HEADER. escapeHtml
// alone is not enough for a subject — it passes CR/LF straight through — so the subject goes through
// stripControlChars as well. `org.slug` reaches a URL PATH, so it is encodeURIComponent'd rather than
// HTML-escaped (slugs are validated at creation, but this renderer must not depend on that).

import { renderBrandedEmail, type RenderedEmail } from "@webhook-co/shared/email-shell";

import { stripControlChars } from "./email-html";
import { APP_BASE_URL } from "./urls";

/** Mirror of packages/db FreeOrgCapWarningContext — kept local so this DOM-typed app doesn't import the
 *  Node-typed db package (the destination-disabled precedent). */
export interface FreeOrgCapWarningContext {
  readonly graceUntilIso: string;
  readonly cap: number;
}

/** Mirror of packages/db FreeOrgCapSuspendedContext. No restore deadline — nothing enforces one. */
export interface FreeOrgCapSuspendedContext {
  readonly cap: number;
}

/** The org's display identity, resolved by the notifier (never from `context`). Null when unresolvable. */
export interface EmailOrg {
  readonly name: string | null;
  readonly slug: string | null;
}

/**
 * Which of the two pre-suspension notices this is (slice 4b). Both say the same thing about the same deadline
 * — that is the POINT, not duplication: the notify drain is at-most-once (an intent is claimed pending→sent
 * BEFORE the Resend call), so a single 5xx on the `initial` send would otherwise lose the only warning and the
 * org would be suspended in silence. The `reminder` is a second, independently-sent copy so no single send
 * failure can swallow the notice. It only reframes the opening line — everything else is deliberately
 * identical, because a reader who missed the first one needs the whole message, not a diff.
 */
export type WarningVariant = "initial" | "reminder";

export type { RenderedEmail };

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * Format a date in UTC, e.g. "Jul 30, 2026 (UTC)". Built from explicit getUTC fields rather than
 * Intl/toLocale so it renders identically on workerd + Node (the destination-disabled precedent). The zone is
 * NAMED because these are deadlines: a bare "Jul 30" is a full calendar day off for a reader far enough west,
 * who would plan around a date that already passed. Returns null for a value that isn't a usable date — a
 * malformed context must degrade the wording, never throw: a render throw is claimed-but-never-sent, i.e. a
 * silently lost notification.
 */
function formatDay(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()} (UTC)`;
}

/**
 * The org's name for prose. Falls back to a neutral stand-in when it couldn't be resolved — and the fallback
 * has to read correctly BOTH sentence-initial ("<X> has been suspended") and mid-sentence ("upgrade <X> to a
 * paid plan"), which is why it's a lowercase noun phrase rather than a capitalized one. `sentenceStart()`
 * capitalizes it where a sentence opens with it.
 */
const UNNAMED_ORG = "one of your organizations";

function orgLabel(org: EmailOrg): string {
  const name = org.name?.trim();
  return name && name !== "" ? name : UNNAMED_ORG;
}

/** Capitalize the fallback label when it opens a sentence. A real org name is returned untouched — a user who
 *  lower-cased their own org's name meant it. */
function sentenceStart(label: string): string {
  return label === UNNAMED_ORG ? "One of your organizations" : label;
}

/** Deep-link into the org, falling back to the dashboard root when the slug is unknown. */
function orgUrl(org: EmailOrg, path: string): string {
  const slug = org.slug?.trim();
  if (!slug || slug === "") return APP_BASE_URL;
  return `${APP_BASE_URL}/org/${encodeURIComponent(slug)}${path}`;
}

/** A positive integer cap for prose, or null if the context carried something unusable. */
function capOf(cap: number): number | null {
  return Number.isInteger(cap) && cap > 0 ? cap : null;
}

/**
 * "up to 2 free organizations per user" — or a number-less phrase if the cap didn't survive the round-trip.
 * "per user" is load-bearing: the cap is counted per OWNER, but the email goes to EVERY owner of the org
 * (the notifier resolves recipients by membership). A co-owner who is not themselves over the cap must not
 * read a second-person accusation ("you're over the limit") they can neither verify nor fix.
 */
function capPhrase(cap: number | null): string {
  return cap === null
    ? "a limited number of free organizations per user"
    : `up to ${cap} free organizations per user`;
}

/**
 * The warning: this org is over the free-org cap and will be suspended on `graceUntil`. The org is still
 * FULLY ACTIVE — the email must not imply anything has stopped working yet.
 *
 * Two claims this copy deliberately does NOT make. It does not call the org "your newest" or "the one" that
 * will be suspended: the reconciler flags EVERY org past the cap, so a paid→Free downgrade leaving N orgs
 * over sends N of these, and a reader told theirs is the only one at risk would fix that one and be blindsided
 * by the rest. And it does not accuse the reader of being over the cap: the count is per-OWNER but the mail
 * goes to every owner (see {@link capPhrase}).
 */
export function renderFreeOrgCapWarningEmail(
  ctx: FreeOrgCapWarningContext | null,
  org: EmailOrg,
  variant: WarningVariant = "initial",
): RenderedEmail {
  const label = orgLabel(org);
  // A null/unreadable context DEGRADES ("soon", "a limited number") rather than blocking the send. The drain
  // claims before rendering, so a renderer that refuses is a notification lost forever with no retry — and
  // this family exists precisely so a suspension is never a surprise. destination_disabled sets the same
  // precedent by passing a null context straight through.
  const day = ctx === null ? null : formatDay(ctx.graceUntilIso);
  const cap = ctx === null ? null : capOf(ctx.cap);
  const when = day === null ? "soon" : `on ${day}`;

  const reminder = variant === "reminder";

  return renderBrandedEmail({
    // The SUBJECT carries the same constraint as the opening line, and is read FIRST. "Reminder:" asserts a
    // prior notice exactly as "a follow-up on the notice we sent earlier" did — and is false for the same two
    // readers (a warning lost to a 5xx; an owner added mid-grace). "Still scheduled" distinguishes the second
    // notice from the first without claiming the first arrived.
    subject: stripControlChars(
      reminder
        ? `Still scheduled: ${label} will be suspended ${when}`
        : `Heads up: ${label} will be suspended ${when}`,
    ),
    heading: `${sentenceStart(label)} will be suspended ${when}`,
    preview: `It's over the free plan's limit of ${capPhrase(cap)}. Nothing has changed yet — here's how to keep it.`,
    paragraphs: [
      // The reminder's opening must NOT reference the earlier notice. This email exists precisely BECAUSE
      // that one may never have arrived: the drain marks an intent 'sent' before the Resend call, so 'sent'
      // records an attempt, not a delivery. "A follow-up on the notice we sent earlier" would therefore be
      // read, by the exact person this slice was built for, as "you ignored us" — and would send them
      // hunting their spam folder for an email that does not exist. Recipients are also re-resolved from
      // current membership at drain time, so an owner ADDED during the grace window never got the first one
      // either. "Still over" is true for every recipient regardless of what landed.
      reminder
        ? `${sentenceStart(label)} is still over the free plan's limit of ${capPhrase(cap)}, so it's still scheduled to be suspended ${when}.`
        : `The free plan covers ${capPhrase(cap)}, and ${label} is over that limit — so it's scheduled to be suspended ${when}.`,
      `Nothing has changed yet. Until then it keeps capturing, delivering, and everything else, exactly as it does today.`,
      // Only ONE instruction, and it's the one every recipient can actually act on. The cap is counted
      // per-owner, so "delete a different org to free up a slot" pointed at every owner invites a co-owner who
      // is not the over-cap user to destroy an unrelated org for no effect — nothing they own changes the
      // other owner's count, and this org stays scheduled.
      `To keep it, upgrade ${label} to a paid plan: that takes it out of the free count entirely and this cancels itself. It can also stand down if the owner whose free organizations are over the limit frees up a slot themselves.`,
      `If more than one organization is over the limit, each one gets its own notice like this. Fixing the org named here won't clear the others.`,
      `Already sorted it out? Then ignore this — nothing will happen ${when}, and you don't need to reply or tell us.`,
    ],
    cta: { label: "Upgrade this organization", url: orgUrl(org, "/billing") },
    footer: `You're receiving this because you're an owner of a webhook.co organization that's over the free plan's limit. It's a service notification about your account — there's nothing to unsubscribe from.`,
  });
}

/**
 * The suspension: the grace window expired and the org is now suspended.
 *
 * Two claims this copy is careful about, both because an earlier draft got them backwards.
 *
 * RETENTION. The org is never deleted, but its EVENTS are not preserved: retention.ts prunes purely on
 * `received_at` with no `orgs.status` predicate, and the webhook_retention role's grant on orgs is
 * (id, retention_days) — it cannot even see that an org is suspended. So "nothing has been deleted" is true
 * only at send time. What is durably true: config is kept, events age out as usual, restore sooner to keep
 * more. No retention number is quoted — the plan owns that and a hardcoded one here would drift.
 *
 * NO DEADLINE. There isn't one: a cap-suspended org can be restored at any time, forever. 0083 carried an
 * `orgs.restore_deadline` column for a hard-delete slice that was never built; nothing read it, and a draft
 * of this email turned it into "you have until <date> to restore it" — a deadline the system did not enforce,
 * and the kind an owner who missed it reads as "too late, don't bother". 0087 dropped the column. The copy
 * doesn't raise deadlines in EITHER direction (a "there's no deadline" promise would have to be walked back
 * the day a hard-delete ships). The real urgency is the event retention above, and the copy puts it there.
 */
export function renderFreeOrgCapSuspendedEmail(
  ctx: FreeOrgCapSuspendedContext | null,
  org: EmailOrg,
): RenderedEmail {
  const label = orgLabel(org);
  // Degrades on a null context — see the warning renderer. `cap` is a nice-to-have here (it only shapes one
  // phrase), so refusing to send a suspension notice over a missing number would be absurd.
  const cap = ctx === null ? null : capOf(ctx.cap);

  return renderBrandedEmail({
    subject: stripControlChars(`${sentenceStart(label)} has been suspended`),
    heading: `${sentenceStart(label)} has been suspended`,
    preview: `It was over the free plan's limit of ${capPhrase(cap)}. You can restore it whenever you're ready — here's how.`,
    paragraphs: [
      `The free plan covers ${capPhrase(cap)}. ${sentenceStart(label)} was over that limit and the notice period has now passed, so we've suspended it.`,
      // Precisely what suspension does: requireActiveOrgAccess redirects every data page to /suspended, so
      // "read-only dashboard" (an earlier draft) was wrong — the data isn't browsable-but-frozen, it's behind
      // a notice. Settings and Billing deliberately stay open, because they're the way out.
      `What that means: we've stopped capturing new events for it, delivery is on hold, and its dashboard now shows a suspension notice in place of your data. Settings and billing stay open, because that's where you fix it.`,
      // Deliberately says nothing about WHEN a restore takes effect or what happens to held deliveries. Both
      // were claimed by an earlier draft and both were false: the restore is applied by this cron, but the
      // held backlog is re-woken by a SEPARATE hourly cron with no ordering between them (so "within the
      // hour" was wrong), and those held delivery_attempts are cascade-deleted with their events by the
      // retention prune anyway (so "they go out automatically" was wrong in the other direction). Retention is
      // the one time-pressure that is real, and it's stated — that's enough.
      `Its endpoints, destinations, settings, and team are all kept, and restoring puts them back. Events are the one thing that doesn't wait: they keep aging out on the free plan's usual retention while it's suspended, so the sooner you restore it, the more history you keep.`,
      // The remedy a co-owner can actually act on comes FIRST and is the only instruction. The cap is counted
      // per-owner, so telling every recipient to "delete a different org to free up a slot" invites a co-owner
      // who is not the over-cap user to destroy an unrelated org for no effect — the suspension is driven by
      // someone else's count and would re-apply on the next pass.
      `To bring it back, upgrade it to a paid plan — that takes it out of the free count. It can also come back if the owner whose free organizations are over the limit frees up a slot themselves.`,
      `Already restored it? Then ignore this — it was queued when we suspended it, and your dashboard is the source of truth.`,
    ],
    // Points at BILLING, not /suspended: the label promises a restore, and /suspended is an informational
    // notice with no restore control on it — the reader would have to find a second button to do the thing
    // this one offered. The warning email is held to the same standard.
    cta: { label: "Upgrade to restore", url: orgUrl(org, "/billing") },
    footer: `You're receiving this because you're an owner of a suspended webhook.co organization. It's a service notification about your account — there's nothing to unsubscribe from.`,
  });
}
