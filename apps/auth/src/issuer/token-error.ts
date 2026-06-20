// A2b-2b — sanitize the OAuth provider's /oauth/token error code to our OAuthErrorCode. Kept in its own
// db-free module so it's unit-testable: token-deps (its only other caller) imports @webhook-co/db, whose
// pg-cloudflare → `cloudflare:sockets` import can't load under vitest. This module imports only a type.

import type { OAuthErrorCode } from "./token-core";

/**
 * Map the provider's /oauth/token error to our OAuthErrorCode, sanitized — no provider free-text reaches
 * the client. An auth-code exchange only fails because the grant is bad (expired/replayed code, PKCE or
 * client/redirect mismatch) or the request was malformed; everything else collapses to invalid_grant,
 * never a 5xx that would mask a client error.
 */
export function mapProviderTokenError(providerError: string | undefined): OAuthErrorCode {
  switch (providerError) {
    case "invalid_request":
      return "invalid_request";
    case "invalid_scope":
      return "invalid_scope";
    case "invalid_target":
      return "invalid_target";
    default:
      // invalid_grant / invalid_client / unsupported_grant_type / unknown → the grant can't be exchanged.
      return "invalid_grant";
  }
}
