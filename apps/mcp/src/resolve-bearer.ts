import { API_KEY_PREFIX } from "@webhook-co/db";
import type { VerifyBearer } from "@webhook-co/contract";

// A8a — the two-validator front door for the mcp resource server. mcp accepts two credential kinds:
//   1. a first-party `whk_` access key (the CLI / api-key callers) — resolved by the api-key chain;
//   2. an opaque OAuth provider token (generic 3rd-party MCP clients) — validated by introspection to auth.
//
// The validator is selected by the token PREFIX, and EXACTLY ONE runs. We never try the second after the
// first rejects: a single Authorization header is one credential in one slot, and a fall-through would let
// an attacker feed a `whk_`-shaped value to the introspection path (or vice versa) to probe both — and
// could turn one validator's reject into the other's accept. Discriminate once, commit. Both validators
// audience-bind to MCP_RESOURCE internally (the api-key chain via its resolver, introspection via its
// RFC 8707 re-check), so the audience flows through unchanged.

// `whk_` (the API_KEY_PREFIX joined with mintCredential's `_` separator) is the api-key shape; anything
// else is treated as an opaque provider token.
const API_KEY_TOKEN_PREFIX = `${API_KEY_PREFIX}_`;

export interface ResourceVerifyDeps {
  /** Validates a first-party `whk_` access key (the api-key credential chain, audience-bound). */
  readonly apiKeyVerify: VerifyBearer;
  /** Validates an opaque OAuth provider token via introspection to auth. (audience-bound). */
  readonly introspectVerify: VerifyBearer;
}

/**
 * Build the resource server's VerifyBearer: prefix-discriminate the presented bearer to exactly one
 * validator. No fall-through — the chosen validator's outcome (ok / 401 / operational throw) is final.
 */
export function makeResourceVerifyBearer(deps: ResourceVerifyDeps): VerifyBearer {
  return (token: string, audience: string) =>
    token.startsWith(API_KEY_TOKEN_PREFIX)
      ? deps.apiKeyVerify(token, audience)
      : deps.introspectVerify(token, audience);
}

/**
 * Does this raw `Authorization` value carry MORE THAN ONE credential? The Fetch API coalesces duplicate
 * `Authorization` headers into a single comma-joined value, so a request with two `Authorization` headers
 * (or a hand-crafted `Bearer a, Bearer b`) arrives here as one string. We must not silently parse the first
 * and ignore the rest — that's ambiguous which principal the caller meant. Split on the standard
 * header-list comma and count non-empty members; >1 means the request presented multiple credentials and
 * should be rejected (the caller turns this into a 401), not resolved.
 */
export function hasMultipleCredentials(authorizationHeader: string | null | undefined): boolean {
  if (!authorizationHeader) return false;
  const credentials = authorizationHeader.split(",").filter((part) => part.trim().length > 0);
  return credentials.length > 1;
}
