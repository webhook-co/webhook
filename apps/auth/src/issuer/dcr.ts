// A3 — open-DCR hardening (deferred from A2b-1). The provider's Dynamic Client Registration (/register) is
// open to public clients (the CLI registers itself); without a callback it would store ANY redirect_uri,
// an open-redirect / consent-phishing vector. This validates every registered redirect_uri.
//
// v1 POLICY = HTTP LOOPBACK LITERAL ONLY — 127.0.0.1 or ::1 (the native/CLI client, the only OAuth client
// in v1). Rejected: plain http to any other host (the attack vector), `localhost` (DNS/hosts-hijackable,
// never a true loopback — ADR-0026), AND remote https. We deliberately do NOT yet allow `https` (which
// would let anyone self-register a remote redirect for a confidential/web client): the consent screen that
// gates such a client is A3-main (not built) and DCR rate-limiting is deferred, so until both land
// loopback-only is strictly safer at zero v1 cost (the CLI only needs loopback). **A8 relaxes this to
// allow https for confidential clients once the consent screen + DCR rate-limit exist (future; not yet
// implemented).** Public
// registration stays enabled (disallowPublicClientRegistration unset); this callback is the redirect gate.
//
// Pure + I/O-free → unit-tested; wired into oauthIssuerConfig.clientRegistrationCallback. Validation reads
// `url.hostname` (the parsed host), which defeats userinfo-confusion (`http://127.0.0.1@evil.com` →
// hostname `evil.com` → rejected); IPv4/IPv6 shorthands that canonicalize to a true loopback are allowed.

// new URL() renders an IPv6 host with brackets ("[::1]"); accept the bare form defensively too.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);

/** A redirect_uri is allowed iff it's http to a loopback literal (127.0.0.1/::1; NOT localhost). */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** An OAuth registration-error result; returning it from the callback REJECTS the registration. */
export interface RegistrationRejection {
  code: string;
  description: string;
  status: number;
}

/**
 * Validate a DCR client's metadata. Returns a rejection for a missing/empty redirect_uris or any
 * disallowed entry; undefined to allow. (The provider treats a returned result as a rejection, void/
 * undefined as acceptance.)
 */
export function validateClientRegistration(
  clientMetadata: Record<string, unknown>,
): RegistrationRejection | undefined {
  const redirectUris = clientMetadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return {
      code: "invalid_redirect_uri",
      description: "at least one redirect_uri is required",
      status: 400,
    };
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isAllowedRedirectUri(uri)) {
      return {
        code: "invalid_redirect_uri",
        description: "every redirect_uri must be an http loopback (127.0.0.1 or ::1)",
        status: 400,
      };
    }
  }
  return undefined;
}
