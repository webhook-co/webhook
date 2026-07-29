// The one place transactional mail leaves the building — and the local-dev substitute for it.
//
// Every transactional sender (magic-link, invite, email-change, the notification drain) used to carry its
// own identical POST to Resend. They now all route through `deliverEmail`, which does one of two things:
//
//   EMAIL_MODE unset / "send"  → POST to the Resend REST API, exactly as before.
//   EMAIL_MODE=log             → print the email to the console and make NO network call.
//
// Log mode exists so a developer can sign in on their laptop without a Resend account. The magic-link URL is
// the thing they need, so it is printed plainly; everything else about the mail is printed alongside it so
// an OTP or a notification is just as reachable.
//
// WHY THIS IS FENCED. In production, log mode would be a real incident twice over: single-use sign-in links
// would be written into log storage (a credential, retained and searchable), and no transactional email
// would ever be delivered. So `resolveEmailMode` REFUSES log mode whenever a Resend key arrives as a Secrets
// Store binding — an object with `.get()`, which is the shape ONLY the deploy overlay produces
// (gen-wrangler-prod.mjs emits `secrets_store_secrets`; dev and test pass plain strings).
//
// SCOPE, precisely, because a fence that is trusted beyond its reach is worse than none. There are two
// fences and they cover different things:
//
//   this runtime check          — every deployed Worker whose Resend key is a Secrets Store binding, which
//                                 is what the overlay produces. So: a var typed into the Cloudflare
//                                 dashboard, a `wrangler secret put EMAIL_MODE`, a stray build-time env.
//   scripts/dev-mode-guard.mjs  — every committed Worker config, the deploy overlay, and the workflows
//                                 (`wrangler deploy --var EMAIL_MODE:log` inside a workflow is caught here).
//
// One route is covered by NEITHER: a hand-run `wrangler deploy --var EMAIL_MODE:log` against a Worker whose
// Resend key was set with `wrangler secret put` rather than Secrets Store — the guard never sees the command
// because it was never committed, and the runtime fence sees a plain string. It is not reachable as this
// repo deploys (gen-wrangler-prod.mjs binds RESEND_API_KEY via `secrets_store_secrets` unconditionally for
// both auth and web, and a Worker cannot hold both a store binding and a `secret put` secret of the same
// name), but it is honest to say it is uncovered rather than to assign it to the other fence.

/** Where transactional mail goes. `send` is production; `log` is the hermetic local substitute. */
export type EmailMode = "send" | "log";

/** The four transactional senders. One per caller of {@link deliverEmail}. */
export type EmailKind = "magic-link" | "invite" | "email-change" | "notification";

/** A secret as it arrives from the Worker env: a Secrets Store binding (prod) or a plain string (dev/test). */
type MaybeSecret = unknown;

export interface EmailTransport {
  readonly mode: EmailMode;
  /** Resend API key. Unused (and typically empty) in log mode. */
  readonly apiKey: string;
  /** Verified sender, e.g. "login@mail.webhook.co". */
  readonly from: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to console.log. Log mode only. */
  readonly logImpl?: (line: string) => void;
}

export interface OutboundEmail {
  /**
   * Recipient(s), passed to Resend VERBATIM. Both shapes are accepted because the callers differ and the
   * wire format is deliberately left alone: the notification drain sends a one-element array, the rest send
   * a bare string, and Resend treats `to` as `string | string[]`. Normalising here would have been a silent
   * change to what four senders put on the wire, for no gain.
   */
  readonly to: string | readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  /**
   * Short label for this mail. Appears in the failure message (`<kind> email send failed with status N`)
   * and heads the log-mode block. A closed union rather than a string: the four values ARE the four
   * senders, and each one is spliced into an error message that callers and tests match on, so a typo
   * would silently change a contract rather than fail to compile.
   */
  readonly kind: EmailKind;
  /**
   * The one URL the mail exists to deliver, when it has one. Surfaced on its own line in log mode so a
   * developer never has to dig it out of rendered HTML. Absent for mails with nothing to click (the
   * email-change OTP, by design).
   */
  readonly link?: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** True for a Secrets Store binding — an object with a `.get()` method. The production shape. */
function isSecretsStoreBinding(value: MaybeSecret): boolean {
  return typeof (value as { get?: unknown } | null)?.get === "function";
}

/**
 * Resolve the email transport mode from the Worker env, failing closed.
 *
 * Throws when log mode is asked for in something that looks like production (a Secrets Store Resend key),
 * and when EMAIL_MODE holds a value that is neither mode — a typo must never silently pick a behaviour.
 */
export function resolveEmailMode(env: {
  EMAIL_MODE?: string;
  RESEND_API_KEY?: MaybeSecret;
}): EmailMode {
  // A blank value is UNSET, not a typo. `pnpm dev:secrets` writes an unconfigured key as `EMAIL_MODE=`,
  // which arrives here as "" — treating that as an unknown mode made every app reading a generated
  // .dev.vars throw at the request boundary, on a file our own generator produced.
  const mode = env.EMAIL_MODE?.trim();
  if (mode === undefined || mode === "" || mode === "send") return "send";
  if (mode !== "log") {
    throw new Error(`EMAIL_MODE must be "send" or "log" (got ${JSON.stringify(mode)})`);
  }
  if (isSecretsStoreBinding(env.RESEND_API_KEY)) {
    throw new Error(
      "refusing EMAIL_MODE=log: RESEND_API_KEY is a Secrets Store binding, which only a deployed " +
        "Worker has. Log mode prints sign-in links to the console and sends no mail — it is a local-dev " +
        "substitute and must never run in production.",
    );
  }
  return "log";
}

/** Flatten the verbatim `to` for display only — the wire value is never touched. */
function recipients(to: string | readonly string[]): string {
  return Array.isArray(to) ? to.join(", ") : (to as string);
}

/** Render the log-mode block. Kept pure so its content is testable without capturing console. */
function logLines(from: string, email: OutboundEmail): string[] {
  const lines = [
    `📧 [EMAIL_MODE=log] ${email.kind} → ${recipients(email.to)}`,
    `   from:    ${from}`,
    `   subject: ${email.subject}`,
  ];
  if (email.link) lines.push(`   link:    ${email.link}`);
  // The text part carries everything a linkless mail exists to deliver (an OTP code, a usage figure), so it
  // is printed too rather than summarised away.
  lines.push("   ---", email.text, "   ---");
  return lines;
}

/**
 * Deliver one transactional email. Resolves on success; in send mode throws on any non-2xx with a message
 * that carries the kind and the status code but NEVER the API key.
 */
export async function deliverEmail(transport: EmailTransport, email: OutboundEmail): Promise<void> {
  if (transport.mode === "log") {
    const write = transport.logImpl ?? ((line: string) => console.log(line));
    for (const line of logLines(transport.from, email)) write(line);
    return;
  }

  const doFetch = transport.fetchImpl ?? fetch;
  const res = await doFetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${transport.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: transport.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
  });

  if (!res.ok) {
    throw new Error(`${email.kind} email send failed with status ${res.status}`);
  }
}
