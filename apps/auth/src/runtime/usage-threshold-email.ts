// The "usage threshold" notification email (S4.3b, warn-before-pause). Pure renderer — the notifier cron
// wires the send. Mirrors the destination-disabled email's posture: self-contained HTML, no tracking, the
// only remote asset is our own brand logo (a static image, not a pixel; the email carries no single-use
// link a scanner could burn). NO prices/tiers — only the org's OWN numbers (usage vs its cap). All values
// are locally generated (counts, dates), so there is nothing user-controlled to inject; we still escape the
// subject/preview defensively.

/** The producer's snapshot (mirror of packages/db UsageThresholdContext — kept local so this DOM-typed app
 *  doesn't import the Node-typed db package). `threshold` is the percent-of-cap point (80 | 100). */
import { escapeHtml as esc } from "./email-html";
export interface UsageThresholdContext {
  readonly usage: number;
  readonly eventCap: number;
  readonly threshold: number;
  readonly pausePolicy: "pause" | "allow";
  /** When the allowance resets — `null` for the one-time lifetime allowance, which never resets. */
  readonly periodEndIso: string | null;
  /** `lifetime` = the one-time Free allowance; `billing_cycle` = a paid plan's per-cycle volume. */
  readonly capKind: "lifetime" | "billing_cycle";
}

export interface UsageThresholdEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const DASHBOARD_URL = "https://app.webhook.co/usage";
const LOGO_URL = "https://www.webhook.co/logo.png";

/** Fixed-locale thousands separator so the email is deterministic (workerd + Node identical), not host-locale. */
function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

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

/** Format a period-reset instant in UTC as "Aug 1, 2026" — deterministic (explicit getUTC fields, no Intl). */
function fmtResetDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "the start of your next billing period";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function detailRow(label: string, valueHtml: string, valueColor = "#18181b"): string {
  return `<tr>
    <td width="150" style="padding:4px 0; font-size:13px; line-height:20px; color:#71717a; vertical-align:top; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${label}</td>
    <td style="padding:4px 0; font-size:13px; line-height:20px; color:${valueColor}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${valueHtml}</td>
  </tr>`;
}

/**
 * Render the usage-threshold warning for one owner. `threshold` selects the copy: <100 = approaching (a
 * heads-up), 100 = at the cap. `pausePolicy` decides what hitting the cap MEANS — 'pause' pauses capture
 * (nothing lost is a lie here: over-cap events are refused, so we say so honestly), 'allow' keeps capturing
 * (overage). `capKind` decides whether the allowance RESETS: a paid `billing_cycle` resets on a date, the
 * Free `lifetime` allowance is one-time and never resets — so we must never promise it a reset date, and we
 * point at upgrading instead. NO price is shown; the org sees only its own usage/cap.
 */
export function renderUsageThresholdEmail(ctx: UsageThresholdContext): UsageThresholdEmail {
  const atCap = ctx.threshold >= 100;
  const pauses = ctx.pausePolicy === "pause";
  const lifetime = ctx.capKind === "lifetime";
  // Only meaningful for a billing cycle. Defensive: a cycle with no end falls back to a generic phrase.
  const resetStr =
    ctx.periodEndIso === null
      ? "the start of your next billing period"
      : fmtResetDate(ctx.periodEndIso);
  const pct = ctx.eventCap > 0 ? Math.min(100, Math.round((ctx.usage / ctx.eventCap) * 100)) : 100;

  const subject = lifetime
    ? atCap
      ? pauses
        ? "You've used your free events — capture is paused"
        : "You've used your free events"
      : `You've used ${ctx.threshold}% of your free events`
    : atCap
      ? pauses
        ? "You've reached your event limit — capture is paused"
        : "You've reached your included event limit"
      : `You've used ${ctx.threshold}% of your included events`;

  // The lead paragraph: what's happening + the consequence, honest about pause AND about whether it resets.
  const lead = lifetime
    ? atCap
      ? pauses
        ? `You've used all ${fmtCount(ctx.eventCap)} events in your one-time free allowance. To avoid a surprise bill we don't charge for overage — instead, new events are paused and won't be captured. Your free allowance doesn't reset, so upgrade to resume capturing right away.`
        : `You've used all ${fmtCount(ctx.eventCap)} events in your one-time free allowance. Additional events will keep being captured as overage. Your free allowance doesn't reset.`
      : `You've used ${ctx.threshold}% of the ${fmtCount(ctx.eventCap)} events in your one-time free allowance. ${
          pauses
            ? `If you reach 100%, new events are paused. Your free allowance doesn't reset, so upgrade to keep capturing.`
            : `Beyond 100%, additional events are captured as overage. Your free allowance doesn't reset.`
        }`
    : atCap
      ? pauses
        ? `You've used all ${fmtCount(ctx.eventCap)} events included in your current period. To avoid a surprise bill we don't charge for overage — instead, new events are paused and won't be captured until your limit resets on ${resetStr}. Raise your limit to resume capturing right away.`
        : `You've used all ${fmtCount(ctx.eventCap)} events included in your current period. Additional events this period will keep being captured as overage. Your included allotment resets on ${resetStr}.`
      : `You've used ${ctx.threshold}% of the ${fmtCount(ctx.eventCap)} events included in your current period. ${
          pauses
            ? `If you reach 100%, new events are paused until your limit resets on ${resetStr}.`
            : `Beyond 100%, additional events are captured as overage. Your allotment resets on ${resetStr}.`
        }`;

  const usageColor = atCap ? "#b91c1c" : "#18181b";
  const usedLabel = lifetime ? "Used" : "Used this period";
  const resetLabel = lifetime ? "Allowance" : "Resets";
  const resetValue = lifetime ? "One-time — does not reset" : resetStr;
  const rows = [
    detailRow(
      usedLabel,
      `${fmtCount(ctx.usage)} of ${fmtCount(ctx.eventCap)} events (${pct}%)`,
      usageColor,
    ),
    detailRow(resetLabel, esc(resetValue)),
  ].join("\n");

  const preview = lifetime
    ? atCap
      ? pauses
        ? "You've used your one-time free allowance — capture is paused."
        : "You've used all the events in your one-time free allowance."
      : `You've used ${ctx.threshold}% of your one-time free allowance.`
    : atCap
      ? pauses
        ? "You've hit your event limit — capture is paused until your limit resets."
        : "You've used all your included events for this period."
      : `You've used ${ctx.threshold}% of your included events this period.`;

  const closing =
    lifetime && pauses
      ? "Upgrade in the dashboard to resume capturing."
      : pauses
        ? "Manage your limit or review your usage in the dashboard."
        : "Review your usage in the dashboard.";

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <title>${esc(subject)}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f4f5;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${esc(preview)}</div>
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
              <td style="padding:22px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:20px; font-weight:600; line-height:28px; color:#18181b;">${esc(subject)}</td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:24px; color:#3f3f46;">${esc(lead)}</td>
            </tr>
            <tr>
              <td style="padding:20px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fafafa" style="background-color:#fafafa; border:1px solid #e4e4e7; border-radius:8px;">
                  <tr>
                    <td style="padding:16px 18px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${rows}
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 4px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="#18181b" style="background-color:#18181b; border-radius:8px;">
                      <a href="${DASHBOARD_URL}" style="display:inline-block; padding:11px 20px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; font-weight:600; line-height:20px; color:#ffffff; text-decoration:none;">View your usage</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:24px; color:#3f3f46;">${esc(closing)}</td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e4e4e7; font-size:0; line-height:0;">&nbsp;</td></tr></table></td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:13px; line-height:20px; color:#71717a;">You're receiving this because you own a webhook.co organization approaching its usage limit. It's a service notification about your account &mdash; there's nothing to unsubscribe from.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    subject,
    "",
    lead,
    "",
    `  ${usedLabel}: ${fmtCount(ctx.usage)} of ${fmtCount(ctx.eventCap)} events (${pct}%)`,
    `  ${resetLabel}: ${resetValue}`,
    "",
    `View your usage: ${DASHBOARD_URL}`,
    "",
    closing,
    "",
    "You're receiving this because you own a webhook.co organization approaching its usage limit.",
  ].join("\n");

  return { subject, html, text };
}
