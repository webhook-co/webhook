// A1b-1 — the magic-link email sender. Better Auth's magicLink plugin invokes this from its
// `sendMagicLink` callback; we deliver via the Resend REST API (no SDK) from the verified sender on
// mail.webhook.co. Tracking is disabled at the Resend domain level — email security scanners pre-fetch
// tracked links and would burn the single-use token before the user clicks — so the send carries no
// tracking flags. The API key is never interpolated into an error message.
//
// This used to render as bare <p> tags, described here as "no remote images / tracking pixels". It now uses
// the shared branded shell, which loads a logo from our own domain — so the "no remote images" half of that
// claim is gone, deliberately. What it was protecting still holds: what burns a single-use token is a
// scanner FOLLOWING the link, which is why tracking (i.e. link REWRITING) stays off. Fetching a static logo
// reveals only that some copy of the mail exists — never the token — and the token appears in no image URL.
//
// The link is also echoed under the button as plain text: a rewritten or unrendered button must never be
// the only way to reach the one thing this email exists to deliver.

import { renderBrandedEmail } from "@webhook-co/shared/email-shell";

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

function render(url: string) {
  return renderBrandedEmail({
    subject: SUBJECT,
    heading: "Sign in to webhook.co",
    preview: "Your single-use sign-in link — it expires in a few minutes.",
    paragraphs: [
      "Click the button below to sign in. The link expires in a few minutes and can be used once.",
      "If you didn't request this, you can ignore this email — nobody can sign in without the link.",
    ],
    cta: {
      label: "Sign in to webhook.co",
      url,
      fallbackNote: "If the button doesn't work, paste this link into your browser:",
    },
    footer:
      "You're receiving this because someone asked for a sign-in link for this address. It's a one-time security email — there's nothing to unsubscribe from.",
  });
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
  const email = render(message.url);
  const res = await doFetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${deps.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: deps.from,
      to: message.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });

  if (!res.ok) {
    throw new Error(`magic-link email send failed with status ${res.status}`);
  }
}

// --- Durable send rate-limit (ADR-0027 must-before-live) ----------------------------------------------
// Better Auth's magic-link plugin rate-limits in-memory, which is per-isolate on Workers and so
// ineffective fleet-wide for a public, email-triggering endpoint. This is the durable replacement: a
// fixed-window counter over RATELIMIT_KV (the A4c-1 limiter), keyed by the recipient email — bounding
// inbox-bombing of one address. The bucket is hashed inside consumeRateLimit, so KV never holds the raw
// email. (IP / overall-volume throttling is the edge/WAF layer's job — a separate deploy follow-up; keeping
// this off Better Auth's endpoint-context shape avoids coupling to its internals.)

import { consumeRateLimit, type RateLimitKv } from "../issuer/rate-limit";

/** Decide whether a magic-link send is allowed for this email. true = send; false = throttle. */
export type MagicLinkRateLimit = (email: string) => Promise<boolean>;

// ~15-minute window (KV's TTL floor is 60s): 5 sends per email — generous for a real user re-requesting a
// link, tight enough to blunt inbox-bombing.
const EMAIL_RULE = { limit: 5, windowSeconds: 900 } as const;

/**
 * Build the durable magic-link send throttle over RATELIMIT_KV, keyed by the recipient email. Returns false
 * only when the window is exhausted. Fails OPEN on a limiter/KV fault — login availability beats a strict
 * throttle during an infra blip, and the exposure is bounded (the window + the hashed key + write-protected KV).
 */
export function makeMagicLinkRateLimit(
  kv: RateLimitKv,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): MagicLinkRateLimit {
  return async (email) => {
    try {
      const result = await consumeRateLimit(
        { kv, nowSeconds },
        `magic-link:email:${email.toLowerCase()}`,
        EMAIL_RULE,
      );
      return result.allowed;
    } catch {
      return true; // fail open — never block login on a limiter fault
    }
  };
}
