// The REST API's auth surface. It binds to the CONTRACT seam (VerifyBearer, AuthContext,
// the RFC 9728 PRM / RFC 6750 challenge builders) and NEVER imports the api-key
// implementation directly — verifyBearer is injected so api keys today and OAuth tokens
// tomorrow share this exact call site. The implementation lives in @webhook-co/db
// (makeVerifyBearer over the credential resolver); this surface only knows the seam.

import {
  authenticateBearer,
  authorizeBearer,
  extractBearer as extractBearerHeader,
  type BearerAuthzResult,
  type BearerAuthzDeps,
} from "@webhook-co/contract";

/** Outcome of authorizing a request for a specific capability (the shared seam result). */
export type AuthzResult = BearerAuthzResult;

/** The API surface's auth deps — exactly the shared bearer-authorize deps. */
export type ApiAuthDeps = BearerAuthzDeps;

/** Pull a Bearer token out of a request's Authorization header, or null if absent/malformed. */
export function extractBearer(req: Request): string | null {
  return extractBearerHeader(req.headers.get("authorization"));
}

/**
 * Authorize a request to invoke `capabilityName`. Thin adapter over the shared
 * `authorizeBearer` decision (extract token -> verify -> scope -> 401/403); the surface only
 * adapts its Request. Operational faults propagate (5xx), never masked as a 401.
 */
export function authorize(
  deps: ApiAuthDeps,
  req: Request,
  capabilityName: string,
): Promise<AuthzResult> {
  return authorizeBearer(deps, req.headers.get("authorization"), capabilityName);
}

/**
 * Authenticate a request WITHOUT a capability scope (the identity path behind `GET /v1/whoami`).
 * Thin adapter over the shared `authenticateBearer` decision; a valid credential for this resource
 * is sufficient. Same 401-vs-5xx split as authorize, just no scope step.
 */
export function authenticate(deps: ApiAuthDeps, req: Request): Promise<AuthzResult> {
  return authenticateBearer(deps, req.headers.get("authorization"));
}
