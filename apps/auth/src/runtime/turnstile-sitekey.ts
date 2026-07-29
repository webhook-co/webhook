// Which Turnstile sitekey the login widget renders with.
//
// The login form keeps its submit button disabled until Turnstile hands back a token, so on a developer's
// laptop the widget is the difference between "I can sign in locally" and a button that never enables.
//
// On localhost we render Cloudflare's documented always-pass TEST sitekey; everywhere else, the real one.
//
// WHY NOT JUST USE THE REAL KEY LOCALLY. The real widget's Cloudflare-side config is understood to list
// localhost and 127.0.0.1 among its allowed domains, so it would probably work. "Probably", from a remote
// setting nobody in this repo can see or test, is the problem: if someone tightens that domain list, local
// sign-in breaks for every contributor with no failing test anywhere and no obvious cause. Local
// development should not depend on a production widget's remote configuration — that is the same coupling
// this whole lane exists to remove.
//
// THIS IS NOT A SECURITY BOUNDARY, and it is worth being precise about why. A sitekey is public by design,
// and choosing one client-side decides nothing: the server siteverifies with the SECRET key, and a token
// minted by the test sitekey fails verification against the real secret. A visitor who patched their own
// browser to send the test sitekey would gain exactly nothing. The gate is the secret, server-side.
//
// The local server-side captcha stays UNWIRED (no TURNSTILE_SECRET_KEY locally), which is deliberate rather
// than lazy: siteverify with the test secret returns `hostname: "example.com"` and no action, so the
// plugin's `allowedHostnames` / `expectedAction` pins would REJECT it. Wiring the test secret would break
// local login rather than fix it. Verified against the live siteverify endpoint. The honest consequence is
// a real parity gap — the captcha gate is not exercised locally — and it belongs in the parity ledger, not
// papered over by loosening a security control's config for dev.

/**
 * Public Cloudflare Turnstile sitekey for the login widget. Sitekeys are designed to be embedded in
 * client HTML (the SECRET, not this, is sensitive — TURNSTILE_SECRET_KEY in Secrets Store). The widget's
 * Cloudflare-side config lists the allowed domains; the server gate separately pins the single
 * configured-origin host (see buildAuthConfig's allowedHostnames).
 */
export const TURNSTILE_SITEKEY = "0x4AAAAAADpHI5M8IwMT8Zw_";

/**
 * Cloudflare's published "always passes, visible widget" TEST sitekey. Documented and stable:
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 * It is not a credential and not ours — it is the same value in every project that tests Turnstile.
 */
export const TURNSTILE_TEST_SITEKEY = "1x00000000000000000000AA";

/** Hosts that are unambiguously this machine. Matched EXACTLY — `localhost.attacker.example` is not one. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Pick the sitekey for a page served from `hostname`.
 *
 * Fails safe: anything not unambiguously loopback gets the real key, so a preview host or an unexpected
 * hostname never quietly renders a widget that passes everyone.
 */
export function resolveTurnstileSitekey(hostname: string): string {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase()) ? TURNSTILE_TEST_SITEKEY : TURNSTILE_SITEKEY;
}
