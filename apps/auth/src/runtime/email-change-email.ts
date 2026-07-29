import { renderBrandedEmail } from "@webhook-co/shared/email-shell";
import { deliverEmail, type EmailMode } from "@webhook-co/shared/email-transport";

import { NOTIFICATIONS_FROM } from "./urls";

// Resend senders for the email-change ceremony — the step-up OTP (to the CURRENT address) and the
// after-the-fact security notice (to the OLD address). Same shape as the magic-link sender: a plain Resend
// REST POST, the shared branded shell, and an API key that never appears in an error message.
//
// Tracking stays off at the Resend domain level. The shell's only remote asset is our own logo, which
// carries no code and reveals nothing but the mail's existence — see magic-link.ts for the full reasoning
// behind dropping the previous "no remote images" claim.
//
// The OTP mail deliberately has NO button: a code is typed back into a screen the user already has open, so
// there is nothing here to click, and a link would only teach the habit this ceremony guards against.

export interface EmailSenderDeps {
  readonly apiKey: string;
  /** "send" (Resend, the production default) or "log" (console, local dev). See email-transport. */
  readonly mode?: EmailMode;
  readonly fetchImpl?: typeof fetch;
}

async function send(
  deps: EmailSenderDeps,
  message: { to: string; subject: string; html: string; text: string },
): Promise<void> {
  await deliverEmail(
    {
      mode: deps.mode ?? "send",
      apiKey: deps.apiKey,
      from: NOTIFICATIONS_FROM,
      fetchImpl: deps.fetchImpl,
    },
    { ...message, kind: "email-change" },
  );
}

/** The 6-digit step-up code, to the user's CURRENT email (proves control of the address on record). */
export function sendEmailChangeOtp(
  deps: EmailSenderDeps,
  input: { to: string; code: string },
): Promise<void> {
  const email = renderBrandedEmail({
    subject: "Your webhook.co verification code",
    heading: "Your verification code",
    preview: "Enter this code to confirm your new email address. It expires in 10 minutes.",
    code: input.code,
    paragraphs: [
      "Enter this code on the email-change screen to confirm your new address. It expires in 10 minutes.",
      "If you didn't request this, you can ignore this email — your address hasn't changed.",
    ],
    footer:
      "You're receiving this because someone asked to change the email on your webhook.co account. It's a security email — there's nothing to unsubscribe from.",
  });
  return send(deps, { to: input.to, ...email });
}

/** The after-the-fact notice, to the OLD address — so a hijack is detectable by the person who held it. */
export function sendEmailChangedNotice(
  deps: EmailSenderDeps,
  input: { to: string; newEmail: string },
): Promise<void> {
  // `newEmail` is attacker-controlled in the exact scenario this email exists to expose. The shell escapes
  // every string it renders, so it reaches the body as inert text.
  const email = renderBrandedEmail({
    subject: "Your webhook.co email was changed",
    heading: "Your email was changed",
    preview: `The address on your account is now ${input.newEmail}.`,
    paragraphs: [
      `The email on your webhook.co account was just changed to ${input.newEmail}.`,
      "If you made this change, there's nothing to do.",
      "If you didn't, your account may be compromised — contact support@webhook.co right away and we'll help you get it back.",
    ],
    footer:
      "You're receiving this at your previous address because the email on the account changed. It's a security email — there's nothing to unsubscribe from.",
  });
  return send(deps, { to: input.to, ...email });
}
