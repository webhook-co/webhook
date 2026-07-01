// The "destination auto-disabled" notification email (S3 Slice 3 PR3c-3b). Pure renderer — the notifier cron
// wires the send. Mirrors the magic-link sender's posture: self-contained HTML, no tracking, and the ONLY
// remote asset is the brand logo on our own domain (a static image, not a tracking pixel — and this email
// carries no single-use link a scanner pre-fetch could burn). The destination URL + error are user-influenced,
// so every interpolated value is HTML-escaped to keep them out of the markup.

/** The engine's context snapshot (mirror of packages/db NotificationContext — kept local so this DOM-typed
 *  app doesn't import the Node-typed db package). */
export interface DestinationDisabledContext {
  readonly destinationUrl: string;
  readonly failureCount: number;
  readonly lastError: string | null;
  readonly lastStatusCode: number | null;
}

export interface DestinationDisabledEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const SUBJECT = "A delivery destination was paused";
const DASHBOARD_URL = "https://app.webhook.co/destinations";
const LOGO_URL = "https://www.webhook.co/logo.png";

/** Escape the five HTML-significant characters so a user-controlled URL / error string can't inject markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "HTTP 502 · Bad Gateway" / "Bad Gateway" / "Connection timed out" — the human error line, or null if none. */
function formatError(ctx: DestinationDisabledContext): string | null {
  const code = ctx.lastStatusCode === null ? null : `HTTP ${ctx.lastStatusCode}`;
  const msg = ctx.lastError && ctx.lastError.trim() !== "" ? ctx.lastError.trim() : null;
  if (code && msg) return `${code} · ${msg}`;
  return code ?? msg;
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

/** Format the paused-at instant in UTC, e.g. "Jul 1, 2026 at 14:32 UTC". Built from explicit getUTC fields
 *  rather than the Intl/toLocale APIs, so it renders identically on workerd + Node and is fully deterministic. */
function formatPausedAt(at: Date): string {
  const mon = MONTHS[at.getUTCMonth()];
  const day = at.getUTCDate();
  const year = at.getUTCFullYear();
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${mon} ${day}, ${year} at ${hh}:${mm} UTC`;
}

/** One label/value row in the details panel (value pre-escaped by the caller when user-influenced). */
function detailRow(label: string, valueHtml: string, valueColor = "#18181b", mono = false): string {
  const family = mono
    ? "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"
    : "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return `<tr>
    <td width="130" style="padding:4px 0; font-size:13px; line-height:20px; color:#71717a; vertical-align:top; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${label}</td>
    <td style="padding:4px 0; font-size:13px; line-height:20px; color:${valueColor}; word-break:break-all; font-family:${family};">${valueHtml}</td>
  </tr>`;
}

/**
 * Render the auto-disable notification for one owner. `pausedAt` is the intent's created_at (when the engine
 * disabled the destination). The design is locked (founder-approved): centered logo + wordmark, a details
 * panel (destination · reason · last error · paused), reassurance that events are queued, and a single CTA to
 * the dashboard. Every user-influenced value is HTML-escaped.
 */
export function renderDestinationDisabledEmail(
  ctx: DestinationDisabledContext | null,
  pausedAt: Date,
): DestinationDisabledEmail {
  const errorLine = ctx ? formatError(ctx) : null;
  const pausedStr = formatPausedAt(pausedAt);
  const reason = ctx ? `${ctx.failureCount} consecutive failed deliveries` : null;

  // Graceful degrade: a pre-migration (context-less) intent still gets a valid email — just without the
  // destination/reason/error specifics. The owner is always notified; only the extra detail is missing.
  const rows = [
    ctx ? detailRow("Destination", esc(ctx.destinationUrl), "#18181b", true) : "",
    reason ? detailRow("Reason", esc(reason)) : "",
    errorLine ? detailRow("Last error", esc(errorLine), "#b91c1c", true) : "",
    detailRow("Paused", esc(pausedStr)),
  ]
    .filter((r) => r !== "")
    .join("\n");

  const preview = ctx
    ? `We paused ${esc(ctx.destinationUrl)} after ${ctx.failureCount} consecutive failures. Your events are safe and queued.`
    : "We paused one of your delivery destinations after repeated failures. Your events are safe and queued.";

  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <title>${esc(SUBJECT)}</title>
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
              <td style="padding:22px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:20px; font-weight:600; line-height:28px; color:#18181b;">A delivery destination was paused</td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:24px; color:#3f3f46;">We automatically paused one of your delivery destinations after it failed too many times in a row. We stop retrying a destination that keeps failing so we're not hammering an endpoint that isn't accepting webhooks.</td>
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
              <td style="padding:20px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:24px; color:#3f3f46;">Nothing was lost. The events are still captured and queued &mdash; delivery resumes automatically the moment you re-enable the destination.</td>
            </tr>
            <tr>
              <td style="padding:24px 32px 4px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="#18181b" style="background-color:#18181b; border-radius:8px;">
                      <a href="${DASHBOARD_URL}" style="display:inline-block; padding:11px 20px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; font-weight:600; line-height:20px; color:#ffffff; text-decoration:none;">Review it in your dashboard</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:24px; color:#3f3f46;">Check that the endpoint above is reachable and returning a <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px;">2xx</span>, then re-enable the destination. If you meant to turn it off, you can ignore this &mdash; it'll stay paused.</td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e4e4e7; font-size:0; line-height:0;">&nbsp;</td></tr></table></td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:13px; line-height:20px; color:#71717a;">You're receiving this because you own a webhook.co organization with a paused destination. It's a one-time service notification about your account &mdash; there's nothing to unsubscribe from.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    "A delivery destination was paused",
    "",
    "We automatically paused one of your delivery destinations after it failed too many times in a row. We stop retrying a destination that keeps failing so we're not hammering an endpoint that isn't accepting webhooks.",
    "",
    ...(ctx ? [`  Destination:  ${ctx.destinationUrl}`] : []),
    ...(reason ? [`  Reason:       ${reason}`] : []),
    ...(errorLine ? [`  Last error:   ${errorLine}`] : []),
    `  Paused:       ${pausedStr}`,
    "",
    "Nothing was lost. The events are still captured and queued - delivery resumes automatically the moment you re-enable the destination.",
    "",
    `Review it in your dashboard: ${DASHBOARD_URL}`,
    "",
    "Check that the endpoint above is reachable and returning a 2xx, then re-enable the destination. If you meant to turn it off, you can ignore this - it'll stay paused.",
    "",
    "You're receiving this because you own a webhook.co organization with a paused destination.",
  ].join("\n");

  return { subject: SUBJECT, html, text };
}
