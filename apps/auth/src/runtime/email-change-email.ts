import { NOTIFICATIONS_FROM } from "./urls";

// Resend senders for the email-change ceremony — the step-up OTP (to the CURRENT address) and the
// after-the-fact security notice (to the OLD address). Same shape as the magic-link sender: a plain Resend
// REST POST, no tracking pixels / remote images (scanners pre-fetch and would burn the code), and the API key
// never appears in an error message.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface EmailSenderDeps {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

async function send(
  deps: EmailSenderDeps,
  message: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  const doFetch = deps.fetchImpl ?? fetch;
  const res = await doFetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: NOTIFICATIONS_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    }),
  });
  if (!res.ok) throw new Error(`email-change email send failed with status ${res.status}`);
}

/** The 6-digit step-up code, to the user's CURRENT email (proves control of the address on record). */
export function sendEmailChangeOtp(
  deps: EmailSenderDeps,
  input: { to: string; code: string },
): Promise<void> {
  const subject = "Your webhook.co verification code";
  const text = [
    `Your verification code is ${input.code}.`,
    "",
    "Enter it on the email-change screen to confirm your new address. It expires in 10 minutes.",
    "If you didn't request this, you can ignore this email — your address hasn't changed.",
  ].join("\n");
  const html = [
    `<p>Your verification code is <strong style="font-size:20px;letter-spacing:2px">${input.code}</strong>.</p>`,
    "<p>Enter it on the email-change screen to confirm your new address. It expires in 10 minutes.</p>",
    "<p>If you didn't request this, you can ignore this email — your address hasn't changed.</p>",
  ].join("");
  return send(deps, { to: input.to, subject, html, text });
}

/** The after-the-fact notice, to the OLD address — so a hijack is detectable by the person who held it. */
export function sendEmailChangedNotice(
  deps: EmailSenderDeps,
  input: { to: string; newEmail: string },
): Promise<void> {
  const subject = "Your webhook.co email was changed";
  const text = [
    `The email on your webhook.co account was just changed to ${input.newEmail}.`,
    "",
    "If you made this change, no action is needed.",
    "If you did NOT, your account may be compromised — contact support@webhook.co right away.",
  ].join("\n");
  const html = [
    `<p>The email on your webhook.co account was just changed to <strong>${input.newEmail}</strong>.</p>`,
    "<p>If you made this change, no action is needed.</p>",
    "<p>If you did <strong>not</strong>, your account may be compromised — contact " +
      '<a href="mailto:support@webhook.co">support@webhook.co</a> right away.</p>',
  ].join("");
  return send(deps, { to: input.to, subject, html, text });
}
