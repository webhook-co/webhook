// Pure URL/string constants shared by the server runtime AND the client wiring. Kept dependency-free
// (no @webhook-co/shared etc.) so importing them into a "use client" component can't pull server-only
// code (the crypto packages) into the browser bundle.

export const PROD_AUTH_BASE_URL = "https://auth.webhook.co";
export const APP_BASE_URL = "https://app.webhook.co";
/** Lane E's login page (this surface). The issuer bounces an unauthenticated `/authorize` here with a
 * `?redirect=` back to the original request; Lane E's login page honors it on success. */
export const LOGIN_PATH = "/login";
/** The verified Resend sender (mail.webhook.co; tracking off — see magic-link.ts). */
export const MAGIC_LINK_FROM = "login@mail.webhook.co";
/** The verified Resend sender for service notifications (auto-disable emails etc.), same domain, named. */
export const NOTIFICATIONS_FROM = "webhook.co <notifications@mail.webhook.co>";

// The sitekey (and the localhost test-key substitution) lives in its own module — re-exported here so
// existing importers are unaffected.
export {
  TURNSTILE_SITEKEY,
  TURNSTILE_TEST_SITEKEY,
  resolveTurnstileSitekey,
} from "./turnstile-sitekey";
/**
 * The Turnstile `action` — set as the widget's render action AND asserted server-side (the captcha plugin's
 * `expectedAction`) to reject a token minted for a different action on this sitekey. (The load-bearing
 * anti-replay pin is `allowedHostnames`; the action is a same-sitekey defense-in-depth.) Doubles as the
 * `turnstile-spin-v1` activation-telemetry tag.
 */
export const TURNSTILE_ACTION = "turnstile-spin-v1";
