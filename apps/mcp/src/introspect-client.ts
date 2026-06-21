import {
  AudienceMismatchError,
  UnauthenticatedError,
  type AuthContext,
  type IntrospectionResult,
  type VerifyBearer,
} from "@webhook-co/contract";

// A8a — the opaque-token validator. mcp is a resource server, not the issuer: a provider OAuth token is
// opaque and KV-bound to auth., so mcp can't validate it locally. It introspects the token over the
// AUTH_ISSUER service binding (auth.'s IssuerIntrospect.introspect, A2b-5) and adapts the result to the
// SAME VerifyBearer seam the api-key path uses — so the resource-server authorize logic stays uniform.
//
// The RFC 8707 audience re-check is mcp's own obligation (RFC 9728): the introspection result reports the
// audience the token was minted for, and we reject anything not bound to OUR resource — a token minted for
// api. must not be replayable at mcp. Pure + injected (the RPC is a seam) so success / reject / fail-closed
// paths are unit-tested with no binding; index.ts wires the real env.AUTH_ISSUER.

export interface IntrospectVerifyDeps {
  /** The introspection RPC seam — auth.'s IssuerIntrospect.introspect over the AUTH_ISSUER binding. */
  readonly introspect: (token: string) => Promise<IntrospectionResult>;
}

/**
 * mcp honors an opaque token only if it is bound EXCLUSIVELY to this resource. A token whose audience is
 * absent, differs, OR additionally names another resource is rejected: a multi-resource token would also
 * be valid at api. — a parallel credential we don't accept here (RFC 8707 + R4). Throws → 401, never coerced.
 */
function assertSoleAudience(tokenAudience: string | string[] | undefined, expected: string): void {
  const audiences =
    tokenAudience === undefined
      ? []
      : Array.isArray(tokenAudience)
        ? tokenAudience
        : [tokenAudience];
  if (audiences.length !== 1 || audiences[0] !== expected) {
    throw new AudienceMismatchError(
      expected,
      audiences.length === 0 ? undefined : audiences.join(","),
    );
  }
}

/**
 * Build a VerifyBearer that validates an opaque provider token via introspection. An inactive token, or
 * an active token whose result carries no usable principal, is an EXPECTED auth rejection
 * (UnauthenticatedError → 401); a wrong audience is AudienceMismatchError → 401; an operational fault from
 * the binding propagates (→ 5xx, never a masked 401). Fails closed: never returns a half-populated principal.
 */
export function makeIntrospectVerifyBearer(deps: IntrospectVerifyDeps): VerifyBearer {
  return async (token: string, audience: string): Promise<AuthContext> => {
    const result = await deps.introspect(token);
    if (!result.active) {
      throw new UnauthenticatedError("token is not active");
    }
    // mcp's own RFC 8707 audience binding — a token minted for (or also for) another resource is not
    // usable here. A missing audience can't be confirmed against this resource, so it mismatches (fail closed).
    assertSoleAudience(result.audience, audience);
    // An active result MUST carry a usable principal; a poisoned/partial result must not pass as one with,
    // say, an undefined org, a non-string scope, or a non-string userId that later bypasses a check or
    // misroutes principal isolation (A8c). Deny, don't coerce.
    if (
      typeof result.orgId !== "string" ||
      result.orgId === "" ||
      !Array.isArray(result.scopes) ||
      !result.scopes.every((s) => typeof s === "string") ||
      (result.userId !== undefined && typeof result.userId !== "string")
    ) {
      throw new UnauthenticatedError(
        "introspection returned an active token without a valid principal",
      );
    }
    return {
      orgId: result.orgId,
      scopes: result.scopes,
      ...(result.userId !== undefined ? { userId: result.userId } : {}),
    };
  };
}
