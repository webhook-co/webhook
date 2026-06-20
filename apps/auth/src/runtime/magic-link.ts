// A1b-1 — the magic-link email sender. Better Auth's magicLink plugin invokes this from its
// `sendMagicLink` callback; we deliver via the Resend REST API (no SDK) from the verified sender on
// mail.webhook.co. Tracking is disabled at the Resend domain level — email security scanners pre-fetch
// tracked links and would burn the single-use token before the user clicks — so the send carries no
// tracking flags. The API key is never interpolated into an error message.

export interface MagicLinkSenderDeps {
  /** Resend API key (a Secrets-Store secret at runtime). */
  apiKey: string;
  /** Verified sender, e.g. "login@mail.webhook.co". */
  from: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface MagicLinkMessage {
  to: string;
  url: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const SUBJECT = "Your webhook.co sign-in link";

function renderHtml(url: string): string {
  // Intentionally plain: one explicit link, no remote images / tracking pixels.
  return [
    `<p>Click the link below to sign in to webhook.co. It expires in a few minutes and can be used once.</p>`,
    `<p><a href="${url}">Sign in to webhook.co</a></p>`,
    `<p>If you didn't request this, you can ignore this email.</p>`,
  ].join("\n");
}

function renderText(url: string): string {
  return [
    "Sign in to webhook.co using the link below. It expires in a few minutes and can be used once.",
    "",
    url,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");
}

/**
 * Send a single-use magic-link email via Resend. Resolves on a 2xx; throws on any other status with a
 * message that contains the status code but never the API key.
 */
export async function sendMagicLinkEmail(
  deps: MagicLinkSenderDeps,
  message: MagicLinkMessage,
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
      html: renderHtml(message.url),
      text: renderText(message.url),
    }),
  });

  if (!res.ok) {
    throw new Error(`magic-link email send failed with status ${res.status}`);
  }
}
