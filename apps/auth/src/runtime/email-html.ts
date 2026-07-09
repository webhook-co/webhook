// Shared text-safety helpers for the notification email renderers (destination_disabled,
// usage_threshold, api_key_revoked). These are SECURITY-RELEVANT: every renderer interpolates at least
// one user-controlled value (a destination URL, a key name) into HTML and into a subject header. They
// lived as byte-identical copies in each renderer, which is exactly the shape where one gets patched and
// the others quietly stay vulnerable — so there is now one copy.

/** Escape a string for interpolation into HTML TEXT or a quoted attribute. Not for URLs or JS contexts. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strip characters that must never appear in an email SUBJECT, which becomes a header: CR/LF (header
 * injection), the other C0 controls, DEL, and the Unicode line separators. Collapses each run to a single
 * space and trims. `escapeHtml` does NOT do this — it is an HTML escaper and passes a bare CR/LF straight
 * through — so any user-controlled value reaching a subject must go through here as well.
 */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars from a header IS the point
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
}
