// The "we revoked your leaked API key" notification email (ADR-0074). Pure renderer — the notifier cron
// wires the send. Mirrors the destination-disabled / usage-threshold posture: self-contained HTML, no
// tracking, the only remote asset is our own brand logo (a static image, not a pixel).
//
// SECURITY NOTES. `keyName` is USER-CONTROLLED (an org names its own keys), so it is escaped everywhere it
// lands in markup — it is the one injectable value in this template. `keyStart` is the same short, non-secret
// display handle the dashboard lists (prefix + a few chars), never the full key: the key is gone anyway, but
// a mailbox is not a place to put credentials. We do NOT name the repository or URL where the leak was found
// — we promise scanning partners we never persist their match metadata, and the owner can find it from their
// own provider's alert.

import { escapeHtml as esc, stripControlChars } from "./email-html";

/** Mirror of packages/db `ApiKeyRevokedContext` — kept local so this DOM-typed app doesn't import the
 *  Node-typed db package (same convention as usage-threshold-email.ts). */
export interface ApiKeyRevokedContext {
  readonly keyName: string;
  readonly keyStart: string;
  readonly source: "github_secret_scanning";
}

export interface ApiKeyRevokedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

const KEYS_URL = "https://app.webhook.co/settings/credentials";
const DOCS_URL = "https://docs.webhook.co/leaked-api-key";
const LOGO_URL = "https://www.webhook.co/logo.png";

/** Longest key name we echo into a SUBJECT line. Names are user-chosen and unbounded.
 *  Only the subject is capped — the body shows the full (escaped) name, so nothing is silently lost. */
const MAX_SUBJECT_NAME = 80;

/** Where the leak was reported from, in prose. Extensible as we enroll with more scanners. */
function sourcePhrase(source: ApiKeyRevokedContext["source"]): string {
  switch (source) {
    case "github_secret_scanning":
      return "GitHub found it in a public repository and told us";
  }
}

function detailRow(label: string, valueHtml: string, valueColor = "#18181b"): string {
  return `<tr>
    <td width="150" style="padding:4px 0; font-size:13px; line-height:20px; color:#71717a; vertical-align:top; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${label}</td>
    <td style="padding:4px 0; font-size:13px; line-height:20px; color:${valueColor}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">${valueHtml}</td>
  </tr>`;
}

/**
 * Render the leaked-key revocation notice for one owner. The key is ALREADY revoked by the time this is
 * queued, so the email reports a completed action — it never asks the owner to go revoke it. The job it has
 * to do is tell them (a) which key, (b) that it no longer works, (c) that anything using it is now broken,
 * and (d) to clean up the source of the leak.
 */
export function renderApiKeyRevokedEmail(ctx: ApiKeyRevokedContext): ApiKeyRevokedEmail {
  // Coerce defensively: `context` is jsonb read back from the DB, so a malformed/legacy row could carry a
  // missing name. A render throw here would be claimed-but-never-sent (see notify-cron's claim-then-render).
  const cleanName = stripControlChars(String(ctx.keyName ?? ""));
  const keyStart = String(ctx.keyStart ?? "");
  const named = cleanName.length > 0;
  // The BODY shows the full name; only the SUBJECT is length-capped (a header, not a paragraph).
  const label = named ? cleanName : "an unnamed key";
  const subjectName = cleanName.slice(0, MAX_SUBJECT_NAME);

  const subject = named
    ? `Your API key "${subjectName}" was leaked and has been revoked`
    : "One of your API keys was leaked and has been revoked";

  const lead =
    `One of your webhook.co API keys was published where anyone could read it — ${sourcePhrase(ctx.source)}. ` +
    `We revoked it the moment we heard, so it stops working right away. ` +
    `You don't need to revoke anything yourself.`;

  const consequence =
    `Anything that was still authenticating with this key will start failing with a 401. ` +
    `Create a replacement, deploy it, and remove the leaked key from wherever it was published — ` +
    `deleting a commit doesn't remove it from the history, so treat the key as burned.`;

  const preview = named
    ? `We revoked "${subjectName}" after it was found in a public repository.`
    : "We revoked an API key after it was found in a public repository.";

  const rows = [
    detailRow("Key", esc(label), "#b91c1c"),
    detailRow("Starts with", `<code>${esc(keyStart)}</code>`),
    detailRow("Status", "Revoked", "#b91c1c"),
  ].join("\n");

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
              <td style="padding:20px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:24px; color:#3f3f46;">${esc(consequence)}</td>
            </tr>
            <tr>
              <td style="padding:24px 32px 4px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="#18181b" style="background-color:#18181b; border-radius:8px;">
                      <a href="${KEYS_URL}" style="display:inline-block; padding:11px 20px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; font-weight:600; line-height:20px; color:#ffffff; text-decoration:none;">Create a new key</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:24px; color:#3f3f46;">Full guidance: <a href="${DOCS_URL}" style="color:#18181b;">${DOCS_URL}</a></td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid #e4e4e7; font-size:0; line-height:0;">&nbsp;</td></tr></table></td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:13px; line-height:20px; color:#71717a;">You're receiving this because you own a webhook.co organization whose API key was exposed. It's a security notification about your account &mdash; there's nothing to unsubscribe from.</td>
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
    `  Key:          ${label}`,
    `  Starts with:  ${keyStart}`,
    `  Status:       Revoked`,
    "",
    consequence,
    "",
    `Create a new key: ${KEYS_URL}`,
    `Full guidance:    ${DOCS_URL}`,
    "",
    "You're receiving this because you own a webhook.co organization whose API key was exposed.",
  ].join("\n");

  return { subject, html, text };
}
