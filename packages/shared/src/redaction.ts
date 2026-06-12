// The loggable-view / redaction boundary. Mandatory on EVERY log/telemetry/audit
// path. events.headers and R2 bodies are stored UNSCRUBBED (that's the inspection
// wedge — §0.1), but they must never be logged unscrubbed: redaction happens at the
// boundary, here, not in storage.

/**
 * Redacts the secret portion of a value for safe logging — keeps a short,
 * non-reversible prefix so logs never leak full secrets/tokens.
 */
export function redactSecret(secret: string, visiblePrefix = 4): string {
  if (secret.length === 0) return "";
  const prefix = secret.slice(0, Math.min(visiblePrefix, secret.length));
  return `${prefix}${"*".repeat(Math.max(secret.length - prefix.length, 0))}`;
}

/**
 * Header names safe to log verbatim. Everything else (signatures, auth, cookies,
 * api keys, tokens) is redacted by redactHeadersForLog. Lowercase; comparison is
 * case-insensitive.
 */
export const LOGGABLE_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "user-agent",
  "accept",
  "accept-encoding",
  "host",
  "date",
  "webhook-id",
  "x-github-event",
  "x-github-delivery",
  "x-shopify-topic",
]);

/**
 * Project ordered header pairs into a loggable view: allowlisted headers pass through;
 * everything else is replaced with "[redacted]" (the value's presence is kept, its
 * content is not). Use this anywhere event headers would otherwise hit a log/span.
 */
export function redactHeadersForLog(
  headers: ReadonlyArray<readonly [string, string]>,
): Array<[string, string]> {
  return headers.map(([name, value]) => [
    name,
    LOGGABLE_HEADER_ALLOWLIST.has(name.toLowerCase()) ? value : "[redacted]",
  ]);
}
