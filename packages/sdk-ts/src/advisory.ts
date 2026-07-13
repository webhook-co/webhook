// CLIENT VERSION ADVISORIES (receiving end).
//
// The SDK identifies itself in its User-Agent; when this version is behind, the API answers with an
// `x-webhook-advisory` header ON A RESPONSE THE CALLER ALREADY ASKED FOR. So the SDK never polls npm, never
// makes an unsolicited network call from inside your Worker/Lambda, and works fine offline — you simply
// hear nothing.
//
// House rules for surfacing it, because a library that nags is a library people vendor to shut it up:
//   - report ONCE per client, not once per request;
//   - prefer the caller's own handler; only fall back to a single stderr line;
//   - be silenceable, and never break a request if any of this goes wrong.

/** A parsed advisory. `deprecated` means BELOW the supported floor — broken, not merely old. */
export interface WebhookAdvisory {
  readonly deprecated: boolean;
  readonly current: string;
  readonly latest: string;
  /** A ready-to-log sentence. Callers are free to ignore it and use the fields. */
  readonly message: string;
}

const KIND = /^(update-available|deprecated);\s*current=([\w.+-]+);\s*latest=([\w.+-]+)$/;

/**
 * Parse the `x-webhook-advisory` header. Returns null for absent OR malformed input — the server is not
 * this SDK's parser, and a hostile/garbled header must never throw inside a caller's request path. The
 * worst it can do is say nothing.
 */
export function parseAdvisory(
  header: string | null | undefined,
  deprecationHeader: string | null | undefined,
): WebhookAdvisory | null {
  if (!header) return null;
  const m = KIND.exec(header.trim());
  if (!m) return null;
  const [, kind, current, latest] = m as unknown as [string, string, string, string];
  const deprecated = kind === "deprecated" || deprecationHeader === "true";
  const message = deprecated
    ? `webhook.co: this SDK version (${current}) is no longer supported and may misbehave. Upgrade to ${latest}: npm install @webhook-co/sdk@latest`
    : `webhook.co: a newer SDK is available (${current} → ${latest}). Upgrade with: npm install @webhook-co/sdk@latest`;
  return { deprecated, current, latest, message };
}

export interface AdvisoryReporterOptions {
  /** Your handler. Given this, the SDK never writes to stderr — it is your log, your rules. */
  readonly onAdvisory?: (advisory: WebhookAdvisory) => void;
  /** Suppress everything, including the stderr fallback. */
  readonly silent?: boolean;
  /** Injected for tests; defaults to console.warn (stderr). */
  readonly warn?: (message: string) => void;
}

/**
 * Build the per-client reporter. It fires at most ONCE — a per-request nag would be a bug, not a feature —
 * and it swallows anything a caller's handler throws, because their logging bug must not become a failed
 * API call.
 */
export function makeAdvisoryReporter(
  options: AdvisoryReporterOptions = {},
): (header: string | null | undefined, deprecationHeader: string | null | undefined) => void {
  let reported = false;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  return (header, deprecationHeader) => {
    if (reported || options.silent === true) return;
    const advisory = parseAdvisory(header, deprecationHeader);
    if (advisory === null) return;
    reported = true;
    try {
      if (options.onAdvisory) options.onAdvisory(advisory);
      else warn(advisory.message);
    } catch {
      // The caller's handler threw. That is their bug — it must not surface as a failed request.
    }
  };
}
