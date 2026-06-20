// A3c — the consent flow logic (pure; injected seams), the two halves of `/authorize`:
//
//   buildConsent — GET /authorize: turn a parsed OAuth authorization request + the authenticated user into
//   either a redirect to the consent screen carrying a signed ticket, a safe OAuth error redirect back to
//   the client, or a 400 when the request itself is untrustworthy.
//
//   decideConsent — POST /consent/decision: verify the round-tripped ticket against the LIVE session, then
//   complete the authorization (mint the auth code via the provider) on approve, or bounce the client with
//   access_denied on deny. Never trusts the page for the userId — it comes from the sealed ticket and is
//   re-checked against the session.
//
// Security invariants enforced here:
//   - the redirect_uri is re-validated as an http loopback literal before we ever redirect to it (A3a/
//     ADR-0026 — defence in depth on top of DCR);
//   - the audience comes ONLY from the request's `resource`, must be exactly one allowed resource, and is
//     recorded in the (encrypted) grant props — never defaulted, never widened;
//   - granted scopes = requested ∩ capability (never widened); an empty result is an error, never minted;
//   - at the decision the ticket's userId MUST equal the live session user (so a stolen/forwarded ticket
//     can't be approved by a different session), AND the double-submit CSRF nonce must match;
//   - approve passes the SAME userId to completeAuthorization that the mint later reads from props.userId —
//     the cross-slice G1 invariant token-core depends on (a mismatch would orphan the vestigial grant);
//   - PII (device name) lives only in the encrypted `props`, never in the provider's unencrypted metadata.

import { isAllowedRedirectUri } from "./dcr";
import type { ConsentAuthRequest, ConsentTicketPayload } from "./consent-ticket";
// The grant-props contract is owned by token-core (the reader). consent-core is the WRITER — it imports the
// SAME type so the two halves of the G1 invariant can't drift (a divergence here would silently break the
// post-mint provider-grant revoke). See token-core's ConsentProps doc.
import type { ConsentProps } from "./token-core";

export type { ConsentProps };

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

/** Request origin trust signals, resolved by the mount from the edge headers. */
export interface AuthorizeOrigin {
  ip: string;
  location: string | null;
}

/** Injected seams for building the consent screen state from an authorization request. */
export interface BuildConsentDeps {
  allowedAudiences: readonly string[];
  /** The capability scope set; requested scopes are intersected against this. */
  allowedScopes: readonly string[];
  /** The minted access-key TTL (shown on screen). */
  keyTtlSeconds: number;
  /** The grant/refresh lifetime ceiling in seconds (shown on screen as an absolute date). */
  grantTtlSeconds: number;
  /** How long (seconds) the user has to decide before the ticket expires. */
  ticketTtlSeconds: number;
  /** The path Lane E's consent screen is served at; the ticket is appended as `?ticket=`. */
  consentPath: string;
  /** Resolve the requesting client's display name (provider lookupClient → clientName), or null. */
  lookupClientName: (clientId: string) => Promise<string | null>;
  /** Resolve the consenting user's consent org (id + name), or null if they have none (not bootstrapped). */
  getConsentOrg: (userId: string) => Promise<{ orgId: string; name: string } | null>;
  /** Seal the authorization state + display fields into a signed, expiring ticket. */
  signTicket: (payload: ConsentTicketPayload) => Promise<string>;
  /** A fresh anti-CSRF nonce for this request. */
  newCsrf: () => string;
  /** Current time in unix seconds (the ticket exp + the displayed grant ceiling derive from it). */
  nowSeconds: () => number;
  log?: LogFn;
}

export type BuildConsentResult =
  /** Redirect the browser to the consent screen, carrying the signed ticket. */
  | { kind: "consent"; location: string }
  /** A safe OAuth error returned to the client via its (already loopback-validated) redirect_uri. */
  | { kind: "redirect"; location: string }
  /** The request itself is untrustworthy (redirect_uri not loopback) — cannot redirect; render a 400. */
  | { kind: "bad_request"; error: string; description: string };

/** Build a redirect back to the client's redirect_uri carrying an OAuth error (+ the echoed state). */
function errorRedirect(redirectUri: string, error: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

/** Normalize the RFC 8707 resource param to exactly one value, or null if absent / more than one. */
function singleResource(resource: string | string[] | undefined): string | null {
  if (typeof resource === "string") return resource;
  if (Array.isArray(resource) && resource.length === 1) return resource[0]!;
  return null;
}

function intersect(requested: readonly string[], allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return [...new Set(requested.filter((s) => set.has(s)))];
}

/**
 * GET /authorize: validate the request, resolve the org + client + scopes + audience, and seal a consent
 * ticket. `userId` is the server-authenticated session user (the mount resolves it; null sessions are sent
 * to login before reaching here). v1 is the interactive loopback-PKCE flow (flow = "pkce_loopback").
 */
export async function buildConsent(
  deps: BuildConsentDeps,
  request: ConsentAuthRequest,
  userId: string,
  origin: AuthorizeOrigin,
): Promise<BuildConsentResult> {
  // The redirect_uri gates whether we can safely bounce errors back. Re-validate it as an http loopback
  // literal (A3a/ADR-0026) — if it isn't, we must NOT redirect to it; render a 400 instead.
  if (!isAllowedRedirectUri(request.redirectUri)) {
    return {
      kind: "bad_request",
      error: "invalid_request",
      description: "redirect_uri is not permitted",
    };
  }

  // Audience: exactly one allowed resource, from the request — never defaulted, never widened.
  const resource = singleResource(request.resource);
  if (resource === null || !deps.allowedAudiences.includes(resource)) {
    return {
      kind: "redirect",
      location: errorRedirect(request.redirectUri, "invalid_target", request.state),
    };
  }

  // Scopes can only narrow: requested ∩ capability. An empty result is an error (never mint blank).
  const scopes = intersect(request.scope, deps.allowedScopes);
  if (scopes.length === 0) {
    return {
      kind: "redirect",
      location: errorRedirect(request.redirectUri, "invalid_scope", request.state),
    };
  }

  const org = await deps.getConsentOrg(userId);
  if (!org) {
    deps.log?.("consent.no_org", { userId });
    return {
      kind: "redirect",
      location: errorRedirect(request.redirectUri, "server_error", request.state),
    };
  }

  const clientName = (await deps.lookupClientName(request.clientId)) ?? request.clientId;
  const now = deps.nowSeconds();

  const ticket = await deps.signTicket({
    request,
    userId,
    orgId: org.orgId,
    orgName: org.name,
    scopes,
    audience: resource,
    clientName,
    origin,
    flow: "pkce_loopback",
    grantExpiresAt: new Date((now + deps.grantTtlSeconds) * 1000).toISOString(),
    keyTtlSeconds: deps.keyTtlSeconds,
    csrf: deps.newCsrf(),
    exp: now + deps.ticketTtlSeconds,
  });

  const url = new URL(deps.consentPath, "https://placeholder.invalid");
  url.searchParams.set("ticket", ticket);
  return { kind: "consent", location: `${deps.consentPath}${url.search}` };
}

/** Injected seams for the consent decision. */
export interface DecideConsentDeps {
  /** Verify + open the round-tripped ticket (null = invalid/expired/forged). */
  verifyTicket: (ticket: string) => Promise<ConsentTicketPayload | null>;
  /** Complete the authorization on the provider → the loopback redirect carrying the code. */
  completeAuthorization: (opts: {
    request: ConsentAuthRequest;
    userId: string;
    scope: string[];
    metadata: Record<string, unknown>;
    props: ConsentProps;
  }) => Promise<{ redirectTo: string }>;
  log?: LogFn;
}

export interface DecideConsentInput {
  /** The ticket echoed back as the requestId (ConsentDecision.requestId). */
  requestId: string;
  /** The double-submit CSRF token from the form body. */
  csrfToken: string;
  decision: "approve" | "deny";
  /** The LIVE session user resolved by the mount (null = not signed in). */
  sessionUserId: string | null;
}

export type DecideResult =
  | { kind: "ok"; redirectTo: string }
  | { kind: "error"; status: number; error: string; description: string };

/**
 * POST /consent/decision: verify the ticket against the live session, then approve (complete the grant) or
 * deny (bounce the client). The userId is taken from the sealed ticket and re-checked against the session —
 * never from the page.
 */
export async function decideConsent(
  deps: DecideConsentDeps,
  input: DecideConsentInput,
): Promise<DecideResult> {
  if (!input.sessionUserId) {
    return {
      kind: "error",
      status: 401,
      error: "login_required",
      description: "no active session",
    };
  }

  const payload = await deps.verifyTicket(input.requestId);
  if (!payload) {
    return {
      kind: "error",
      status: 400,
      error: "invalid_request",
      description: "request expired or invalid",
    };
  }

  // The session deciding must be the user the ticket was issued for (a forwarded/stolen ticket can't be
  // approved by a different session), and the double-submit CSRF nonce must match the sealed one.
  if (payload.userId !== input.sessionUserId) {
    deps.log?.("consent.session_mismatch", {});
    return { kind: "error", status: 403, error: "access_denied", description: "session mismatch" };
  }
  if (payload.csrf !== input.csrfToken) {
    deps.log?.("consent.csrf_mismatch", {});
    return { kind: "error", status: 403, error: "access_denied", description: "csrf mismatch" };
  }

  // Defence in depth: the redirect_uri was loopback-validated in buildConsent and the ticket is HMAC-sealed,
  // so this re-check should never fire — but re-asserting it here means we never bounce to (or hand the
  // provider) a non-loopback uri even if a future ticket-minting path skipped the check, and it fails closed
  // if the sealed payload is malformed (a non-string redirectUri makes isAllowedRedirectUri return false).
  if (!isAllowedRedirectUri(payload.request.redirectUri)) {
    deps.log?.("consent.bad_redirect_uri", {});
    return {
      kind: "error",
      status: 400,
      error: "invalid_request",
      description: "redirect_uri is not permitted",
    };
  }

  if (input.decision === "deny") {
    return {
      kind: "ok",
      redirectTo: errorRedirect(
        payload.request.redirectUri,
        "access_denied",
        payload.request.state,
      ),
    };
  }

  const props: ConsentProps = {
    orgId: payload.orgId,
    userId: payload.userId,
    scopes: payload.scopes,
    audience: payload.audience,
    ...(payload.device ? { device: payload.device } : {}),
  };

  const { redirectTo } = await deps.completeAuthorization({
    request: payload.request,
    userId: payload.userId,
    scope: payload.scopes,
    metadata: {},
    props,
  });

  deps.log?.("consent.approved", {
    userId: payload.userId,
    orgId: payload.orgId,
    scopeCount: payload.scopes.length,
  });
  return { kind: "ok", redirectTo };
}
