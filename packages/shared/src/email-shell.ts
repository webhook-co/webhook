// The one branded email shell: centered logo + wordmark, heading, an optional one-time code, body
// paragraphs, an optional dark CTA, footer. Table-based and inline-styled because email clients have no
// cascade and no <style> support worth relying on.
//
// It lives in `shared` (not in an app) because both senders need it and they sit in different apps:
// apps/auth mails the magic link, the email-change OTP/notice and every notification; apps/web mails the
// team invite. Import it by SUBPATH (`@webhook-co/shared/email-shell`) — apps/web is a Next app, and a
// named binding pulled through this package's `export *` barrel resolves to undefined under Turbopack.
//
// The markup here was lifted verbatim from the free-org-cap notification renderer, which had grown the
// only generalized version of this chrome. That renderer now calls this, so its existing suite pins the
// move as byte-identical; the four transactional emails adopt the same shell and stop being bare <p> tags.
//
// ON THE LOGO: this is a remote fetch, and it is the reason a caller can't claim "no remote images". Most
// clients block remote images by default, so the wordmark beside it is real TEXT, not part of the image —
// a blocked logo still leaves "webhook.co" legible. Nothing secret is ever encoded in an image URL: a
// scanner pre-fetching the logo learns only that some copy of the mail exists, never a link or a code.

/** Escape the five HTML-significant characters. Every string reaching the shell is treated as untrusted:
 *  org names, API key names and inviter addresses are all user-chosen. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const esc = escapeHtml;

const LOGO_URL = "https://www.webhook.co/logo.png";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface EmailCta {
  readonly label: string;
  readonly url: string;
  /** When set, the raw URL is echoed under the button as selectable text, introduced by this note. Opt-in:
   *  it earns its space on a mail whose whole purpose is the link (sign-in, invite) and is noise elsewhere. */
  readonly fallbackNote?: string;
}

export interface EmailShell {
  readonly subject: string;
  readonly heading: string;
  /** Hidden preheader — the line clients show next to the subject in the inbox list. */
  readonly preview: string;
  /** Body paragraphs, in order. Plain text — escaped here. */
  readonly paragraphs: readonly string[];
  /** A one-time code, rendered as the hero between heading and body (the email-change OTP). */
  readonly code?: string;
  /** The single dark call-to-action button. Omit for mails that ask for nothing (a security notice). */
  readonly cta?: EmailCta;
  readonly footer: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Render one branded email into its subject, HTML part and plain-text alternative. */
export function renderBrandedEmail(shell: EmailShell): RenderedEmail {
  const sections: string[] = [];

  if (shell.code !== undefined) {
    sections.push(`            <tr>
              <td style="padding:22px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="#f4f4f5" style="background-color:#f4f4f5; border:1px solid #e4e4e7; border-radius:8px; padding:16px 12px; font-family:${FONT}; font-size:30px; font-weight:600; line-height:36px; letter-spacing:6px; color:#18181b;">${esc(shell.code)}</td>
                  </tr>
                </table>
              </td>
            </tr>`);
  }

  sections.push(
    shell.paragraphs
      .map(
        (p) =>
          `<tr>
              <td style="padding:12px 32px 0 32px; font-family:${FONT}; font-size:15px; line-height:24px; color:#3f3f46;">${esc(p)}</td>
            </tr>`,
      )
      .join("\n"),
  );

  if (shell.cta) {
    sections.push(`            <tr>
              <td style="padding:24px 32px 4px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="#18181b" style="background-color:#18181b; border-radius:8px;">
                      <a href="${esc(shell.cta.url)}" style="display:inline-block; padding:11px 20px; font-family:${FONT}; font-size:14px; font-weight:600; line-height:20px; color:#ffffff; text-decoration:none;">${esc(shell.cta.label)}</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`);

    if (shell.cta.fallbackNote !== undefined) {
      sections.push(`            <tr>
              <td style="padding:18px 32px 0 32px; font-family:${FONT}; font-size:13px; line-height:20px; color:#71717a;">${esc(shell.cta.fallbackNote)}<br /><span style="color:#3f3f46; word-break:break-all;">${esc(shell.cta.url)}</span></td>
            </tr>`);
    }
  }

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
                    <td style="vertical-align:middle; font-family:${FONT}; font-size:20px; line-height:24px; letter-spacing:-0.01em; color:#18181b;">
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
              <td style="padding:22px 32px 0 32px; font-family:${FONT}; font-size:20px; font-weight:600; line-height:28px; color:#18181b;">${esc(shell.heading)}</td>
            </tr>
${sections.join("\n")}
            <tr>
              <td style="padding:24px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e4e4e7; font-size:0; line-height:0;">&nbsp;</td></tr></table></td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px; font-family:${FONT}; font-size:13px; line-height:20px; color:#71717a;">${esc(shell.footer)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  // The text alternative carries the same information, never HTML-escaped — a plain-text reader would see
  // the entities verbatim.
  const lines: string[] = [shell.heading, ""];
  if (shell.code !== undefined) lines.push(shell.code, "");
  lines.push(...shell.paragraphs.flatMap((p) => [p, ""]));
  if (shell.cta) lines.push(`${shell.cta.label}: ${shell.cta.url}`, "");
  lines.push(shell.footer);

  return { subject: shell.subject, html, text: lines.join("\n") };
}
