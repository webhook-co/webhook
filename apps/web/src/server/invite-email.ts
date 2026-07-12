// The invite email sender (Lane 2.5 follow-up). Delivered via the Resend REST API (no SDK, so it runs on
// Workers), from the verified sender on mail.webhook.co — mirroring apps/auth's magic-link sender, which is
// the established pattern for transactional mail here.
//
// The invite link is a BEARER token: whoever opens it can join the org (if their verified email matches).
// So, exactly like the magic link: no tracking pixels, no remote images, one explicit link. Tracking is
// disabled at the Resend domain level anyway — security scanners pre-fetch tracked links and would burn the
// token before the human clicks.
//
// The inviter's email is rendered so the recipient can judge whether they expected this invite (an invite
// email from an unknown person is a phishing signal, and it arrives from OUR domain). It is user-controlled
// data, so it is HTML-ESCAPED. The API key is never interpolated into an error message.

export interface InviteEmailDeps {
  /** Resend API key (a Secrets Store binding at runtime). */
  readonly apiKey: string;
  /** Verified sender, e.g. "invites@mail.webhook.co". */
  readonly from: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface InviteEmailMessage {
  readonly to: string;
  /** The ABSOLUTE accept URL (origin + acceptPath). */
  readonly url: string;
  /** The inviter's email — shown so the recipient can recognise them. User-controlled ⇒ escaped. */
  readonly invitedBy: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SUBJECT = "You've been invited to a team on webhook.co";

/** Escape the five HTML-significant characters. The invite URL is built by us; `invitedBy` is not. */
function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(msg: InviteEmailMessage): string {
  return [
    `<p><strong>${esc(msg.invitedBy)}</strong> invited you to join their team on webhook.co.</p>`,
    `<p><a href="${esc(msg.url)}">Accept the invite</a></p>`,
    `<p>The link expires in 7 days and only works for this email address.</p>`,
    `<p>If you weren't expecting this, you can ignore this email — nothing happens until you accept.</p>`,
  ].join("\n");
}

function renderText(msg: InviteEmailMessage): string {
  return [
    `${msg.invitedBy} invited you to join their team on webhook.co.`,
    "",
    "Accept the invite:",
    msg.url,
    "",
    "The link expires in 7 days and only works for this email address.",
    "If you weren't expecting this, you can ignore this email — nothing happens until you accept.",
  ].join("\n");
}

/**
 * Send one invite email. Resolves on a 2xx; throws on anything else with a message carrying the status code
 * but NEVER the API key. The caller treats a failure as non-fatal — the invite already exists in the DB, and
 * the inviter still has the copy-link, so a mail outage must not lose the invite.
 */
export async function sendInviteEmail(
  deps: InviteEmailDeps,
  message: InviteEmailMessage,
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: deps.from,
      to: message.to,
      subject: SUBJECT,
      html: renderHtml(message),
      text: renderText(message),
    }),
  });

  if (!res.ok) {
    throw new Error(`invite email send failed with status ${res.status}`);
  }
}
