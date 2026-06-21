// A4c-3 — POST /device/verify (the RFC 8628 browser approval entry). The user, on a browser, enters the
// user-code shown on their device; this resolves the pending device-code record and builds the consent
// ticket, redirecting to the SAME /consent screen the PKCE flow uses. Pure HTTP core: the session, the
// rate limiter, the device store, and the consent core are injected, so the contract is unit-tested and the
// deps builder stays thin glue.
//
// Security: the user-code is ~40 bits, so this is the guess surface. Three guards, in order: (1) an authed
// SESSION is required (so a guessed code can only ever be approved into the attacker's OWN org — the
// tenancy invariant the token path assumes), (2) a durable RATE LIMIT keyed on the session principal (the
// attacker-controlled dimension — never the victim's user-code) caps the guess rate and FAILS CLOSED if the
// limiter errors, (3) an unknown vs expired code is indistinguishable (generic 400, anti-enumeration).

import type {
  AuthorizeOrigin,
  BuildDeviceConsentResult,
  DeviceConsentRecord,
} from "./consent-core";
import type { RateLimitResult } from "./rate-limit";

export interface DeviceVerifyRouteDeps {
  /** The live, cookie-derived session user (null = not signed in). */
  getSessionUserId: (request: Request) => Promise<string | null>;
  /** Request origin trust signals (shown on the consent screen). */
  resolveOrigin: (request: Request) => AuthorizeOrigin;
  /** The rate-limit bucket for this principal — keyed on the session user (NOT the user-code). */
  rateLimitBucket: (userId: string) => string;
  /** Consume one unit against the bucket (A4c-1 consumeRateLimit, bound to a rule + KV). */
  rateLimit: (bucket: string) => Promise<RateLimitResult>;
  /** Where to sign in (returning here) — for the 401 body. */
  loginUrl: (returnTo: string) => string;
  /** Resolve a pending device-code record by the user-entered code (A4a findByUserCode → the subset). */
  findDeviceRecord: (userCode: string) => Promise<DeviceConsentRecord | null>;
  /** Build the consent ticket + redirect for the resolved record (A4c-2 buildDeviceConsent, bound). */
  buildDeviceConsent: (
    record: DeviceConsentRecord,
    userId: string,
    origin: AuthorizeOrigin,
  ) => Promise<BuildDeviceConsentResult>;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json;charset=UTF-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      ...headers,
    },
  });
}

export async function handleDeviceVerify(
  deps: DeviceVerifyRouteDeps,
  request: Request,
): Promise<Response> {
  // Require application/json: a cross-site request can't set this MIME without a CORS preflight, so it adds
  // a CSRF defense on top of the session check (matches /consent/decision).
  const mime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mime !== "application/json") {
    return jsonResponse(415, {
      error: "invalid_request",
      error_description: "expected application/json",
    });
  }

  // Session first (cheap, cookie-derived) — an unauthenticated guesser is stopped before the store/limiter.
  const userId = await deps.getSessionUserId(request);
  if (!userId) {
    return jsonResponse(401, { error: "login_required", login_url: deps.loginUrl(request.url) });
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
  const userCode =
    typeof (body as { userCode?: unknown })?.userCode === "string"
      ? (body as { userCode: string }).userCode
      : "";
  if (!userCode) {
    return jsonResponse(400, {
      error: "invalid_request",
      error_description: "user_code is required",
    });
  }

  // Rate-limit the guess surface, keyed on the session principal. Fail CLOSED on a limiter error.
  let rl: RateLimitResult;
  try {
    rl = await deps.rateLimit(deps.rateLimitBucket(userId));
  } catch {
    return jsonResponse(503, { error: "temporarily_unavailable" });
  }
  if (!rl.allowed) {
    return jsonResponse(
      429,
      { error: "slow_down", error_description: "too many attempts" },
      { "retry-after": String(rl.retryAfterSeconds) },
    );
  }

  const record = await deps.findDeviceRecord(userCode);
  if (!record) {
    // Unknown vs expired is indistinguishable (anti-enumeration) — the device_code keyspace + this limit do
    // the work; a generic message reveals nothing.
    return jsonResponse(400, {
      error: "invalid_request",
      error_description: "code is invalid or expired",
    });
  }

  const result = await deps.buildDeviceConsent(record, userId, deps.resolveOrigin(request));
  if (result.kind === "consent") {
    return jsonResponse(200, { redirectTo: result.location });
  }
  return jsonResponse(result.status, {
    error: result.error,
    error_description: result.description,
  });
}
