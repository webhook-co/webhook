// The loggable-view / redaction boundary. Mandatory on EVERY log/telemetry/audit
// path. events.headers and R2 bodies are stored UNSCRUBBED (that's the inspection
// wedge), but they must never be logged unscrubbed: redaction happens at the
// boundary, here, not in storage.

/** Fixed-width mask — deliberately constant so the secret's length isn't disclosed. */
const MASK = "****";

/**
 * Redacts a value for safe logging/display — keeps a short, non-reversible prefix for
 * identification only. The mask is fixed-width (length is never leaked), and a value
 * too short to safely show a prefix is fully masked.
 */
export function redactSecret(secret: string, visiblePrefix = 4): string {
  if (secret.length === 0) return "";
  if (secret.length <= visiblePrefix * 2) return MASK;
  return `${secret.slice(0, visiblePrefix)}${MASK}`;
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
