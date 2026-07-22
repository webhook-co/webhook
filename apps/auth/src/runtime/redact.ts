// Redaction for text that is about to reach a log sink from a frame where a credential is in scope.
//
// The auth crons log `error.message` on failure, and the frames that produce those errors hold a Hyperdrive
// connection string — `postgres://<role>:<password>@<host>/<db>` — as a live argument. Today postgres.js
// does not appear to put the password in `.message`, so this is defence in depth rather than a fix for an
// observed leak. That is precisely why it belongs here: without it, non-leakage depends on an upstream
// library's error formatting, which nothing in this repo pins, and a dependency bump could turn a log line
// into a credential disclosure with no test failing. (no-secrets)

/**
 * Replace the password in any URI-style credential with `***`, leaving the scheme, role, host and database
 * intact — those are already public in this repo's comments and are what makes a failure diagnosable.
 *
 * Matches any `scheme://user:secret@host` run, not just postgres, so a Resend or webhook URL carrying a
 * token is covered by the same pass.
 */
export function redactUriCredentials(text: string): string {
  return text.replace(/([a-zA-Z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@]*(@)/g, "$1***$2");
}

/** The message of an unknown thrown value, with URI credentials redacted. Never throws. */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactUriCredentials(raw);
}
