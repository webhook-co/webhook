// A3d — the pure HTTP contract of the interactive consent endpoints (ADR-0030), mounted at the wrangler
// defaultHandler (ADR-0029):
//
//   GET  /authorize        — parse the OAuth request, resolve the session (→ login if absent), build a
//                            consent ticket, and redirect to Lane E's consent screen (or bounce the client
//                            with an OAuth error, or 400 an untrustworthy request).
//   POST /consent/decision — record the user's approve/deny and return the redirect the consent form
//                            navigates to (the loopback callback with the code on approve; access_denied on
//                            deny).
//
// I/O-free: the provider (parseAuthRequest), the session (getSessionUserId), the consent cores, and the
// origin resolution are injected, so the HTTP contract is unit-testable and the deps builder stays thin glue.

import { ConsentDecisionSchema } from "@webhook-co/contract";

import type {
  AuthorizeOrigin,
  BuildConsentResult,
  DecideConsentInput,
  DecideResult,
} from "./consent-core";
import type { ConsentAuthRequest } from "./consent-ticket";

export interface AuthorizeRouteDeps {
  /** Parse the OAuth authorization request (provider parseAuthRequest); throws on an invalid/unknown client. */
  parseAuthRequest: (request: Request) => Promise<ConsentAuthRequest>;
  /** The live, cookie-derived session user (Better Auth getSession), or null if not signed in. */
  getSessionUserId: (request: Request) => Promise<string | null>;
  /** Request origin trust signals from the edge headers. */
  resolveOrigin: (request: Request) => AuthorizeOrigin;
  /** Where to send an unauthenticated user to sign in, returning here afterwards. */
  loginUrl: (returnTo: string) => string;
  /** Bound consent core (buildConsent + its deps). */
  buildConsent: (
    request: ConsentAuthRequest,
    userId: string,
    origin: AuthorizeOrigin,
  ) => Promise<BuildConsentResult>;
  /** Bound consent core (decideConsent + its deps). */
  decideConsent: (input: DecideConsentInput) => Promise<DecideResult>;
  /**
   * Seal an absolute (cross-origin loopback) redirect URL into a SAME-ORIGIN `/consent/complete?c=…` bounce
   * path. The consent form navigates to this same-origin path (always allowed), and GET /consent/complete
   * 302s to the loopback server-side — the client can't navigate https→http://127.0.0.1 itself (PNA).
   */
  sealLoopbackRedirect: (redirectTo: string) => Promise<string>;
  /** Open a `/consent/complete` ticket → the sealed loopback URL, or null if invalid/expired/non-loopback. */
  openLoopbackRedirect: (ticket: string) => Promise<string | null>;
}

/** A loopback redirect is an absolute http(s) URL; the device flow returns a same-origin relative path. */
function isAbsoluteUrl(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

function redirect(location: string): Response {
  // 303 would also work for the POST→GET case, but the consent form reads {redirectTo} from JSON and
  // navigates itself; the GET redirects here are 302 (the browser follows them directly).
  return new Response(null, { status: 302, headers: { location } });
}

function badRequest(error: string, description?: string): Response {
  return new Response(`${error}${description ? `: ${description}` : ""}`, {
    status: 400,
    headers: { "content-type": "text/plain;charset=UTF-8" },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      // The decision creates a grant — never cache it.
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

/** GET /authorize — the consent entry point. */
export async function handleAuthorize(
  deps: AuthorizeRouteDeps,
  request: Request,
): Promise<Response> {
  let authRequest: ConsentAuthRequest;
  try {
    authRequest = await deps.parseAuthRequest(request);
  } catch {
    // The provider rejected the request (unknown client / mismatched redirect_uri / bad params). We can't
    // trust the redirect_uri, so we don't redirect — return a 400.
    return badRequest("invalid_request", "the authorization request is invalid");
  }

  const userId = await deps.getSessionUserId(request);
  if (!userId) {
    // Not signed in: bounce to login, returning to this /authorize request afterwards. Pass only the
    // RELATIVE path+query (never the absolute URL) so the value Lane E's login page reflects can't be an
    // off-origin open redirect. (Lane E must still reject a redirect that isn't a single-slash path.)
    const here = new URL(request.url);
    return redirect(deps.loginUrl(`${here.pathname}${here.search}`));
  }

  const result = await deps.buildConsent(authRequest, userId, deps.resolveOrigin(request));
  switch (result.kind) {
    case "consent":
    case "redirect":
      return redirect(result.location);
    case "bad_request":
      return badRequest(result.error, result.description);
    default: {
      const _never: never = result;
      return _never;
    }
  }
}

/** POST /consent/decision — record approve/deny. */
export async function handleConsentDecision(
  deps: AuthorizeRouteDeps,
  request: Request,
): Promise<Response> {
  // Require application/json: a cross-site request can't set this exact MIME without a CORS preflight (which
  // we don't grant), so the JSON-only contract adds a CSRF defense on top of the ticket's session-bound
  // userId + double-submit nonce. Parse the MIME type (the bare type before any `;` params) rather than a
  // substring match, so a CORS-safelisted `multipart/form-data; boundary=----application/json` can't slip
  // through the gate.
  const mime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mime !== "application/json") {
    return jsonResponse(415, {
      error: "invalid_request",
      error_description: "expected application/json",
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, {
      error: "invalid_request",
      error_description: "body is not valid JSON",
    });
  }

  const parsed = ConsentDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse(400, { error: "invalid_request", error_description: "invalid decision" });
  }

  // The session user is resolved server-side from the cookie — never from the body (any userId in the body
  // is ignored). decideConsent re-checks it against the sealed ticket.
  const sessionUserId = await deps.getSessionUserId(request);

  const result = await deps.decideConsent({
    requestId: parsed.data.requestId,
    csrfToken: parsed.data.csrfToken,
    decision: parsed.data.decision,
    sessionUserId,
  });

  if (result.kind === "ok") {
    // An absolute redirect is the cross-origin loopback callback — the browser can't reach it via a
    // client-side nav (PNA), so hand back a same-origin /consent/complete bounce that 302s to it. A relative
    // target (the device flow's /device?status=…) is same-origin → navigate to it directly.
    const redirectTo = isAbsoluteUrl(result.redirectTo)
      ? await deps.sealLoopbackRedirect(result.redirectTo)
      : result.redirectTo;
    return jsonResponse(200, { redirectTo });
  }
  return jsonResponse(result.status, {
    error: result.error,
    error_description: result.description,
  });
}

/**
 * GET /consent/complete — the loopback bounce. The consent form navigated here (same-origin) carrying the
 * sealed completion ticket; verify it and issue a SERVER 302 to the loopback callback (browsers follow a
 * top-level 302 to a 127.0.0.1/::1 literal). A missing/invalid/expired/forged ticket 400s — never redirects,
 * so this can't be coerced into an open redirect.
 */
export async function handleConsentComplete(
  deps: AuthorizeRouteDeps,
  request: Request,
): Promise<Response> {
  const ticket = new URL(request.url).searchParams.get("c");
  if (!ticket) {
    return badRequest("invalid_request", "missing completion ticket");
  }
  const loopback = await deps.openLoopbackRedirect(ticket);
  if (!loopback) {
    return badRequest("invalid_request", "the completion link is invalid or has expired");
  }
  return redirect(loopback);
}
