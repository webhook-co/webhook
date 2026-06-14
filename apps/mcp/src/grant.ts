import type { AuthContext } from "@webhook-co/contract";

// The trust boundary where an OAuth grant becomes our AuthContext (§0.8, WS-D2a).
//
// @cloudflare/workers-oauth-provider validates the access token (opaque, KV-backed) and hands
// the grant's `props` to the API handler as `ctx.props: unknown`. Those props were set when the
// grant was minted (completeAuthorization) and are stored encrypted under the token — but this
// module still VALIDATES their shape before trusting them: props are attacker-adjacent (a
// poisoned/garbled KV entry, a future code change that mints the wrong shape) and this is the
// gate that turns them into a typed AuthContext. Fail closed — never coerce a malformed grant
// into a half-populated principal.

/** The props minted into an OAuth grant (completeAuthorization) — exactly the AuthContext shape. */
export interface McpGrantProps {
  readonly orgId: string;
  /** Pseudonymous user id of the principal who authorized the grant (M1). */
  readonly userId?: string;
  readonly scopes: readonly string[];
}

/** Thrown when a grant's props don't match the expected shape — a fail-closed 401/500 signal. */
export class MalformedGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedGrantError";
  }
}

/**
 * Validate an OAuth grant's `props` and return the AuthContext, or throw MalformedGrantError.
 * Validates the FULL shape (not just top-level kinds): a non-empty orgId string, a scopes array
 * of strings, and (if present) a string userId — so a poisoned/partial grant can't pass as a
 * principal with, say, a non-string scope that later bypasses a scope check.
 */
export function grantPropsToAuthContext(props: unknown): AuthContext {
  if (typeof props !== "object" || props === null) {
    throw new MalformedGrantError("grant props are missing or not an object");
  }
  const p = props as Record<string, unknown>;
  if (typeof p.orgId !== "string" || p.orgId === "") {
    throw new MalformedGrantError("grant props.orgId must be a non-empty string");
  }
  if (!Array.isArray(p.scopes) || !p.scopes.every((s) => typeof s === "string")) {
    throw new MalformedGrantError("grant props.scopes must be an array of strings");
  }
  if (p.userId !== undefined && typeof p.userId !== "string") {
    throw new MalformedGrantError("grant props.userId must be a string when present");
  }
  return {
    orgId: p.orgId,
    scopes: p.scopes as readonly string[],
    ...(p.userId !== undefined ? { userId: p.userId as string } : {}),
  };
}
