// Pure URL/string constants shared by the server runtime AND the client wiring. Kept dependency-free
// (no @webhook-co/shared etc.) so importing them into a "use client" component can't pull server-only
// code (the crypto packages) into the browser bundle.

export const PROD_AUTH_BASE_URL = "https://auth.webhook.co";
export const APP_BASE_URL = "https://app.webhook.co";
/** Lane E's login page (this surface). The issuer bounces an unauthenticated `/authorize` here with a
 * `?redirect=` back to the original request; Lane E's login page honors it on success. */
export const LOGIN_PATH = "/login";

/** Better Auth's mount point (`basePath` in the runtime config). Every plugin endpoint hangs off this. */
export const AUTH_BASE_PATH = "/api/auth";
/**
 * The one-tap plugin's endpoint path as it appears on the ENDPOINT CONTEXT — basePath already stripped.
 * This is the form a `databaseHooks` hook sees in `context.path`.
 */
export const ONE_TAP_CALLBACK_PATH = "/one-tap/callback";
/**
 * The same endpoint as a REQUEST path, which is what the Worker dispatch matches on.
 *
 * Derived rather than written out, because the two forms are read by code that never meets. The STRIPPED
 * form is what an endpoint context carries, so the name back-fill hook and the sign-in telemetry map both
 * match on it; the REQUEST form is what the Worker dispatch sees, so the edge throttle and the browser's
 * exchange POST both use this one. Spelling them independently would let a basePath change silently
 * unmeter the endpoint — the gate would simply stop matching, with nothing failing to say so.
 */
export const ONE_TAP_CALLBACK_URL_PATH = `${AUTH_BASE_PATH}${ONE_TAP_CALLBACK_PATH}`;
/** The verified Resend sender (mail.webhook.co; tracking off — see magic-link.ts). */
export const MAGIC_LINK_FROM = "login@mail.webhook.co";
/** The verified Resend sender for service notifications (auto-disable emails etc.), same domain, named. */
export const NOTIFICATIONS_FROM = "webhook.co <notifications@mail.webhook.co>";

// The sitekey lives in its own module, re-exported here for the names that already had importers through
// this module. There is no longer a localhost substitution: the real widget permits localhost, so local
// exercises the real captcha gate. See turnstile-sitekey.ts.
export { TURNSTILE_SITEKEY, resolveTurnstileSitekey } from "./turnstile-sitekey";
/**
 * The Turnstile `action` — set as the widget's render action AND asserted server-side (the captcha plugin's
 * `expectedAction`) to reject a token minted for a different action on this sitekey. (The load-bearing
 * anti-replay pin is `allowedHostnames`; the action is a same-sitekey defense-in-depth.) Doubles as the
 * `turnstile-spin-v1` activation-telemetry tag.
 */
export const TURNSTILE_ACTION = "turnstile-spin-v1";
