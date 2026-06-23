// A4b — POST /device_authorization (RFC 8628 §3.1/§3.2): the device asks for a code pair. Pure HTTP core:
// parse the urlencoded body, validate the client + resource + scopes, mint a device code (A4a store), and
// return the device_code/user_code + verification URIs. I/O-free — the client lookup + the store are
// injected, so the contract is unit-tested and the deps builder stays thin glue.
//
// This endpoint is unauthenticated by design (the device has no user yet); abuse is bounded by the deferred
// edge rate-limit (the device code is short-lived + single-use, and approval still requires an authed
// session at /device — A4c).

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

// A device_authorization body is tiny (client_id + a few scopes + resource). Cap it as defense in depth on
// this unauthenticated endpoint so a huge body / scope list can't force unbounded parse work before the edge
// rate-limit (deferred) is in place.
const MAX_BODY_BYTES = 4096;

export interface DeviceAuthorizeDeps {
  allowedAudiences: readonly string[];
  allowedScopes: readonly string[];
  /** Device-code lifetime in seconds (RFC 8628 expires_in). */
  ttlSeconds: number;
  /** Minimum seconds between polls (RFC 8628 interval). */
  interval: number;
  /** Where the user enters the code (e.g. https://auth.webhook.co/device). */
  verificationUri: string;
  /** Does this client_id exist (a registered public client)? */
  clientExists: (clientId: string) => Promise<boolean>;
  /** Mint + store a device code (A4a createDeviceCode). */
  createDeviceCode: (input: {
    clientId: string;
    scopes: string[];
    audience: string;
    ttlSeconds: number;
    interval: number;
  }) => Promise<{ deviceCode: string; userCode: string; interval: number; expiresIn: number }>;
  log?: LogFn;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}

function oauthError(error: string, description: string): Response {
  // RFC 8628 §3.2 errors mirror the token endpoint: invalid_client is 400 here (no client auth challenge).
  return jsonResponse(400, { error, error_description: description });
}

function singleResource(resource: string | null): string | null {
  return resource && resource.length > 0 ? resource : null;
}

function intersect(requested: string[], allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return [...new Set(requested.filter((s) => set.has(s)))];
}

export async function handleDeviceAuthorization(
  deps: DeviceAuthorizeDeps,
  request: Request,
): Promise<Response> {
  const raw = await request.text();
  // Measure the UTF-8 BYTE length (not `.length`, which counts UTF-16 code units) so a multibyte body
  // / scope list can't slip past a cap intended in bytes.
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return oauthError("invalid_request", "request body too large");
  }
  const params = new URLSearchParams(raw);
  const clientId = params.get("client_id") ?? "";
  if (!clientId) {
    return oauthError("invalid_request", "client_id is required");
  }
  if (!(await deps.clientExists(clientId))) {
    return oauthError("invalid_client", "unknown client");
  }

  // Audience: exactly one allowed resource, from the request — never defaulted.
  const resource = singleResource(params.get("resource"));
  if (resource === null || !deps.allowedAudiences.includes(resource)) {
    return oauthError("invalid_target", "resource must be a single permitted audience");
  }

  // Scopes can only narrow to capability; an empty result is rejected.
  const requested = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const scopes = intersect(requested, deps.allowedScopes);
  if (scopes.length === 0) {
    return oauthError("invalid_scope", "no permitted scope requested");
  }

  const created = await deps.createDeviceCode({
    clientId,
    scopes,
    audience: resource,
    ttlSeconds: deps.ttlSeconds,
    interval: deps.interval,
  });

  deps.log?.("issuer.device.authorized", {
    clientId,
    audience: resource,
    scopeCount: scopes.length,
  });

  const completeUri = new URL(deps.verificationUri);
  completeUri.searchParams.set("user_code", created.userCode);
  return jsonResponse(200, {
    device_code: created.deviceCode,
    user_code: created.userCode,
    verification_uri: deps.verificationUri,
    verification_uri_complete: completeUri.toString(),
    expires_in: created.expiresIn,
    interval: created.interval,
  });
}
