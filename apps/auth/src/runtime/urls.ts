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
