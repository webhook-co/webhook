// A2b-2b — the pure HTTP contract of the frozen /token endpoint (RFC 6749 §5). Parses the urlencoded
// body, dispatches on grant_type to the injected redeem cores (token-core's redeemAuthCode / redeemRefresh
// — already bound to their real deps by the Next mount), and maps the RedeemResult to an OAuth token or
// error response. I/O-free: no provider, no DB, no env — so the contract is unit-testable, and the mount
// (app/api/token/route.ts) stays thin glue. /token is OAuth 2.1 public-client (PKCE); the provider's
// /oauth/token subrequest inside redeemAuthCode does the client/PKCE validation.

import { DEVICE_GRANT_TYPE, type DeviceTokenRequest } from "./device-token-core";
import type { AuthCodeRequest, OAuthErrorCode, RedeemResult, RefreshRequest } from "./token-core";

export interface TokenRouteDeps {
  redeemAuthCode: (req: AuthCodeRequest) => Promise<RedeemResult>;
  /** Wired in A2b-3; until then a refresh_token grant is reported unsupported. */
  redeemRefresh?: (req: RefreshRequest) => Promise<RedeemResult>;
  /** Wired in A4b; until then a device_code grant is reported unsupported. */
  redeemDevice?: (req: DeviceTokenRequest) => Promise<RedeemResult>;
}

// RFC 6749 §5.2: the token error response is 400 for everything except invalid_client (401, which this
// public-client endpoint never emits). A server-side fault is a 500. authorization_pending (RFC 8628) is
// a 400. Everything the cores emit is a client error → 400, except server_error.
function statusFor(error: string): number {
  return error === "server_error" ? 500 : 400;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      // RFC 6749 §5.1: token responses must not be cached.
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function oauthError(
  error: OAuthErrorCode | "unsupported_grant_type",
  description?: string,
): Response {
  return jsonResponse(statusFor(error), {
    error,
    ...(description ? { error_description: description } : {}),
  });
}

function resultToResponse(result: RedeemResult): Response {
  switch (result.kind) {
    case "token":
      return jsonResponse(200, result.body);
    case "pending":
      // Approval flow (dormant in v1) — RFC 8628 polling signal.
      return jsonResponse(400, { error: "authorization_pending" });
    case "error":
      return oauthError(result.error, result.description);
    default: {
      // Exhaustiveness guard: if RedeemResult grows a kind (A2b-4/A3), this fails to compile.
      const _never: never = result;
      return _never;
    }
  }
}

export async function handleTokenRequest(
  deps: TokenRouteDeps,
  request: Request,
): Promise<Response> {
  // URLSearchParams never throws; a non-urlencoded / empty body simply yields no grant_type below.
  const params = new URLSearchParams(await request.text());
  const grantType = params.get("grant_type");

  if (grantType === "authorization_code") {
    const code = params.get("code") ?? "";
    const codeVerifier = params.get("code_verifier") ?? "";
    if (!code || !codeVerifier) {
      return oauthError("invalid_request", "code and code_verifier are required");
    }
    return resultToResponse(
      await deps.redeemAuthCode({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: params.get("redirect_uri") ?? "",
        client_id: params.get("client_id") ?? "",
        resource: params.get("resource") ?? "",
      }),
    );
  }

  if (grantType === "refresh_token") {
    if (!deps.redeemRefresh) {
      return oauthError("unsupported_grant_type", "refresh_token grant is not enabled");
    }
    const refreshToken = params.get("refresh_token") ?? "";
    if (!refreshToken) {
      return oauthError("invalid_request", "refresh_token is required");
    }
    const scope = params.get("scope");
    return resultToResponse(
      await deps.redeemRefresh({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: params.get("client_id") ?? "",
        resource: params.get("resource") ?? "",
        ...(scope ? { scope } : {}),
      }),
    );
  }

  if (grantType === DEVICE_GRANT_TYPE) {
    if (!deps.redeemDevice) {
      return oauthError("unsupported_grant_type", "device_code grant is not enabled");
    }
    const deviceCode = params.get("device_code") ?? "";
    if (!deviceCode) {
      return oauthError("invalid_request", "device_code is required");
    }
    return resultToResponse(
      await deps.redeemDevice({
        grant_type: DEVICE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: params.get("client_id") ?? "",
      }),
    );
  }

  return oauthError(
    "unsupported_grant_type",
    "grant_type must be authorization_code, refresh_token, or device_code",
  );
}
