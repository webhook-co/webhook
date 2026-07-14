/**
 * Validate an untrusted `returnTo`/`next` value as a SAME-ORIGIN relative path — an ORIGIN check, not a
 * byte-pattern (ported from apps/auth's `resolvePostLoginTarget`, generalized over the origin so both the
 * auth handoff and app's callback can reuse it).
 *
 * Browsers strip `\t\n\r` while parsing a `Location`, so `/\t/evil.com` becomes `//evil.com` →
 * `https://evil.com`. We strip those first and judge the value the browser will act on, then resolve it
 * against the given origin and require the origin to be UNCHANGED — a real same-origin test that no `//`,
 * `/\`, `%2f`, `%5c`, or scheme can pass. A bare `/` is not a destination (it just re-enters the host root).
 *
 * Returns the cleaned candidate when safe, else `null` (the caller falls back to a safe default like `/`).
 */
export function sanitizeReturnPath(
  candidate: string | null | undefined,
  origin: string,
): string | null {
  if (candidate == null) return null;
  const cleaned = candidate.replace(/[\t\n\r]/g, "");
  // Must be an absolute path with a real destination after the leading slash (a bare "/" is not a target).
  if (cleaned.length < 2 || cleaned[0] !== "/") return null;
  // Reject origin escapes right after the slash — `//`, `/\`, and the encoded `/%2f` / `/%5c` a decoding
  // proxy could turn back into a slash/backslash (matches Better Auth's own callbackURL guard).
  if (/^\/(?:[/\\]|%2f|%5c)/i.test(cleaned)) return null;
  try {
    if (new URL(cleaned, origin).origin === new URL(origin).origin) return cleaned;
  } catch {
    // An unparseable value (or origin) is not a destination we trust.
  }
  return null;
}
