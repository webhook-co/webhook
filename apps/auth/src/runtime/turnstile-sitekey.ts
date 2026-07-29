// The Turnstile sitekey the login widget renders with — the SAME one everywhere, including localhost.
//
// This used to substitute Cloudflare's always-pass TEST sitekey on loopback hosts, on the theory that the
// real widget might not permit localhost. It does. Verified against the Cloudflare API: the
// `webhook-auth login` widget's domain list is `["127.0.0.1", "auth.webhook.co", "localhost"]`, and the
// same secret verifies tokens from all three.
//
// So the substitution bought nothing and cost the thing that matters: with a test sitekey the local captcha
// gate proved nothing, and the server-side secret had to stay unwired to match — meaning the one security
// control on the public, email-triggering magic-link endpoint was the one control never exercised locally.
// AGENTS.md now forbids exactly that: if it ships in prod it must be exercisable locally through the same
// code path and the same class of credential.
//
// Keeping this as a FUNCTION rather than collapsing it back to a bare constant is deliberate — every call
// site already reads it this way, and a future genuine per-host need has somewhere obvious to live. It has
// no branches, and a test asserts that.

/**
 * Public Cloudflare Turnstile sitekey for the login widget. Sitekeys are designed to be embedded in client
 * HTML — the SECRET is the sensitive half (TURNSTILE_SECRET_KEY, Secrets Store in prod, .dev.vars locally).
 * The widget's Cloudflare-side config lists localhost, 127.0.0.1 and auth.webhook.co; the server gate
 * separately pins the single configured-origin host (see buildAuthConfig's allowedHostnames).
 */
export const TURNSTILE_SITEKEY = "0x4AAAAAADpHI5M8IwMT8Zw_";

/**
 * The sitekey for a page served from `hostname`.
 *
 * One key for every host, because the real widget permits localhost. The parameter is retained so call
 * sites need not change if that ever stops being true.
 */
export function resolveTurnstileSitekey(_hostname: string): string {
  return TURNSTILE_SITEKEY;
}
