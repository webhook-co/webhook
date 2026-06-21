// Shared issuer constants + tiny helpers, single-sourced so the consent screen, the /token mint, the device
// flow, and revoke/introspect can't drift (e.g. the screen advertising a TTL the mint doesn't honor). These
// were duplicated across authorize-deps / device-*-deps / token-deps / introspect-handler; this is the SoT.
// (CAPABILITY_SCOPES stays in oauth-config — the discovery SoT — and is imported from there.)

/** The minted whk_ access key's TTL the consent screen advertises + the /token mint honors (~24h). */
export const KEY_TTL_SECONDS = 86_400;
/** The grant/refresh lifetime ceiling shown on consent + capping the refresh chain (~90d). */
export const GRANT_TTL_SECONDS = 7_776_000;
/** The consent ticket's decision window (5 min, mirrors the magic-link window). */
export const TICKET_TTL_SECONDS = 300;
/** The path of Lane E's consent screen (the issuer redirects `/authorize` + `/device/verify` here). */
export const CONSENT_PATH = "/consent";

/**
 * getOAuthApi needs a full OAuthProviderOptions, but the helpers we use (parseAuthRequest / lookupClient /
 * completeAuthorization / unwrapToken / revokeGrant) work off OAUTH_KV + the request and never invoke
 * defaultHandler — so a never-called 404 stub completes the options without pulling the OpenNext handler in.
 */
export const HELPERS_DEFAULT_HANDLER = { fetch: async () => new Response(null, { status: 404 }) };

/** Unix seconds — the issuer's clock (cursor/consent-ticket/rate-limit timestamps). */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Request-origin trust signal (ip + coarse location) for the consent screen, from the edge headers. */
export interface RequestOrigin {
  ip: string;
  location: string | null;
}

/** A best-effort request-origin trust signal from the edge headers (no @cloudflare/workers-types needed). */
export function resolveOrigin(request: Request): RequestOrigin {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const country = request.headers.get("cf-ipcountry");
  // CF uses "XX"/"T1" for unknown/Tor — treat those as no location rather than a misleading code.
  const location = country && !["XX", "T1"].includes(country) ? country : null;
  return { ip, location };
}
