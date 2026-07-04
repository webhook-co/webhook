// Secret redaction. The SDK holds a bearer credential; a leaked key in an error message, a log line, or
// a debug hook is a credential-disclosure bug. Every string that could reach a human (error messages,
// the optional debug logger) is passed through a redactor so the key can never surface. Two layers:
//   1. exact — replace the caller's registered secret(s) verbatim (covers a self-host key of any shape);
//   2. structural — a backstop that redacts platform tokens (`whk_`/`whsec_`) and `Bearer …` credentials
//      even when the exact value wasn't registered (e.g. a token echoed back inside a server response).

/** The placeholder a redacted secret collapses to. Stable so tests + humans recognise it. */
export const REDACTED = "[redacted]";

// Below this length a "secret" is too short to be a real credential; redacting it would risk nuking
// ordinary substrings of output (an empty string would match everywhere). Registered secrets shorter
// than this are ignored by the exact layer.
const MIN_REDACTABLE_LENGTH = 6;

// Platform-issued opaque tokens: a `whk_` API key or a `whsec_` signing secret, matched structurally.
const WELL_KNOWN_TOKEN = /(whk|whsec)_[A-Za-z0-9_-]{4,}/g;
// A Bearer credential as it would appear in a header dump. Collapsed to `Bearer [redacted]`.
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Redact platform tokens + Bearer credentials from arbitrary text. A structural backstop — it needs no
 * knowledge of the configured key, so it also catches a token a server unexpectedly echoed back.
 */
export function redactWellKnownSecrets(input: string): string {
  return input.replace(WELL_KNOWN_TOKEN, REDACTED).replace(BEARER, `Bearer ${REDACTED}`);
}

/**
 * Build a redactor bound to the caller's known secret(s). The returned function replaces each registered
 * secret verbatim (regex-free, so a secret with regex-special characters is treated literally) and then
 * applies the structural backstop. Secrets shorter than `MIN_REDACTABLE_LENGTH` are ignored.
 */
export function createRedactor(secrets: readonly string[]): (input: string) => string {
  const known = [...new Set(secrets.filter((s) => s.length >= MIN_REDACTABLE_LENGTH))];
  return (input: string): string => {
    let out = input;
    for (const secret of known) out = out.replaceAll(secret, REDACTED);
    return redactWellKnownSecrets(out);
  };
}
