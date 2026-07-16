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

import { escapeHtml as esc, stripControlChars } from "./email-html";
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

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const LOGO_URL = "https://www.webhook.co/logo.png";

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

interface Shell {
  readonly subject: string;
  readonly heading: string;
  readonly preview: string;
  /** Body paragraphs, in order. Plain text — escaped by the shell. */
  readonly paragraphs: readonly string[];
  readonly ctaLabel: string;
  readonly ctaUrl: string;
  readonly footer: string;
}

/** The shared chrome: centered logo + wordmark, heading, body paragraphs, one dark CTA, footer. */
function render(shell: Shell): RenderedEmail {
  const paras = shell.paragraphs
    .map(
      (p) =>
        `<tr>
              <td style="padding:12px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:24px; color:#3f3f46;">${esc(p)}</td>
            </tr>`,
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <title>${esc(shell.subject)}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f4f5;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${esc(shell.preview)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f4f4f5" style="background-color:#f4f4f5;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background-color:#ffffff; border:1px solid #e4e4e7; border-radius:12px;">
            <tr>
              <td align="center" style="padding:28px 32px 22px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                  <tr>
                    <td style="padding-right:9px; vertical-align:middle;">
                      <img src="${LOGO_URL}" width="28" height="28" alt="webhook.co" style="display:block; width:28px; height:28px; border:0; border-radius:6px;" />
                    </td>
                    <td style="vertical-align:middle; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:20px; line-height:24px; letter-spacing:-0.01em; color:#18181b;">
                      <span style="font-weight:600;">webhook</span><span style="font-weight:400; color:#a1a1aa;">.co</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #f4f4f5; font-size:0; line-height:0;">&nbsp;</td></tr></table></td>
            </tr>
            <tr>
              <td style="padding:22px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:20px; font-weight:600; line-height:28px; color:#18181b;">${esc(shell.heading)}</td>
            </tr>
${paras}
            <tr>
              <td style="padding:24px 32px 4px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="#18181b" style="background-color:#18181b; border-radius:8px;">
                      <a href="${esc(shell.ctaUrl)}" style="display:inline-block; padding:11px 20px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; font-weight:600; line-height:20px; color:#ffffff; text-decoration:none;">${esc(shell.ctaLabel)}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e4e4e7; font-size:0; line-height:0;">&nbsp;</td></tr></table></td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:13px; line-height:20px; color:#71717a;">${esc(shell.footer)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    shell.heading,
    "",
    ...shell.paragraphs.flatMap((p) => [p, ""]),
    `${shell.ctaLabel}: ${shell.ctaUrl}`,
    "",
    shell.footer,
  ].join("\n");

  return { subject: shell.subject, html, text };
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
  ctx: FreeOrgCapWarningContext,
  org: EmailOrg,
): RenderedEmail {
  const label = orgLabel(org);
  const day = formatDay(ctx.graceUntilIso);
  const cap = capOf(ctx.cap);
  const when = day === null ? "soon" : `on ${day}`;

  return render({
    subject: stripControlChars(`Heads up: ${label} will be suspended ${when}`),
    heading: `${sentenceStart(label)} will be suspended ${when}`,
    preview: `It's over the free plan's limit of ${capPhrase(cap)}. Nothing has changed yet — here's how to keep it.`,
    paragraphs: [
      `The free plan covers ${capPhrase(cap)}, and ${label} is over that limit — so it's scheduled to be suspended ${when}.`,
      `Nothing has changed yet. Until then it keeps capturing, delivering, and everything else, exactly as it does today.`,
      // Only ONE instruction, and it's the one every recipient can actually act on. The cap is counted
      // per-owner, so "delete a different org to free up a slot" pointed at every owner invites a co-owner who
      // is not the over-cap user to destroy an unrelated org for no effect — nothing they own changes the
      // other owner's count, and this org stays scheduled.
      `To keep it, upgrade ${label} to a paid plan: that takes it out of the free count entirely and this cancels itself. It can also stand down if the owner whose free organizations are over the limit frees up a slot themselves.`,
      `If more than one organization is over the limit, each one gets its own notice like this. Fixing the org named here won't clear the others.`,
      `Already sorted it out? Then ignore this — nothing will happen ${when}, and you don't need to reply or tell us.`,
    ],
    ctaLabel: "Upgrade this organization",
    ctaUrl: orgUrl(org, "/billing"),
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
 * NO DEADLINE. `orgs.restore_deadline` is written and read by NOTHING, so a cap-suspended org can be restored
 * at any time, forever. A draft promised "you have until <date> to restore it" — a deadline the system does
 * not enforce, and the kind an owner who missed it reads as "too late, don't bother". Say the true thing:
 * whenever you're ready. The real urgency is the event retention above, and the copy puts it there.
 */
export function renderFreeOrgCapSuspendedEmail(
  ctx: FreeOrgCapSuspendedContext,
  org: EmailOrg,
): RenderedEmail {
  const label = orgLabel(org);
  const cap = capOf(ctx.cap);

  return render({
    subject: stripControlChars(`${sentenceStart(label)} has been suspended`),
    heading: `${sentenceStart(label)} has been suspended`,
    preview: `It was over the free plan's limit of ${capPhrase(cap)}. You can restore it whenever you're ready — here's how.`,
    paragraphs: [
      `The free plan covers ${capPhrase(cap)}. ${sentenceStart(label)} was over that limit and the notice period has now passed, so we've suspended it.`,
      // Precisely what suspension does: requireActiveOrgAccess redirects every data page to /suspended, so
      // "read-only dashboard" (an earlier draft) was wrong — the data isn't browsable-but-frozen, it's behind
      // a notice. Settings and Billing deliberately stay open, because they're the way out.
      `What that means: we've stopped capturing new events for it, delivery is on hold, and its dashboard now shows a suspension notice in place of your data. Settings and billing stay open, because that's where you fix it.`,
      `Its endpoints, destinations, settings, and team are all kept, and you can restore it whenever you're ready — there's no deadline. Events are the one thing that doesn't wait: they keep aging out on the free plan's usual retention while it's suspended, so the sooner you restore it, the more history you keep.`,
      // The remedy a co-owner can actually act on comes FIRST and is the only instruction. The cap is counted
      // per-owner, so telling every recipient to "delete a different org to free up a slot" invites a co-owner
      // who is not the over-cap user to destroy an unrelated org for no effect — the suspension is driven by
      // someone else's count and would re-apply on the next pass.
      `To bring it back, upgrade it to a paid plan: that takes it out of the free count and it restores within the hour, with any events held for delivery going out automatically. It can also come back if the owner whose free organizations are over the limit frees up a slot themselves.`,
      `Already restored it? Then ignore this — it was queued when we suspended it, and your dashboard is the source of truth.`,
    ],
    ctaLabel: "Restore this organization",
    ctaUrl: orgUrl(org, "/suspended"),
    footer: `You're receiving this because you're an owner of a suspended webhook.co organization. It's a service notification about your account — there's nothing to unsubscribe from.`,
  });
}
