// A-SX-2a — POST /session/exchange (the backchannel redeem). app.'s server presents the single-use ticket
// it received via the post-login redirect; this consumes it (atomic single-use, audience-bound to app.) and
// returns the principal { orgId, userId, name, email, image } so app. can establish its own session.
// auth. + app. are separate origins with host-only cookies, so the principal travels server-to-server here,
// never in the browser.
//
// HTTP shell only: it parses + validates the request, then delegates the consume→profile→principal redeem to
// the shared `redeemSessionExchange` core (session-exchange-core.ts) — the SAME core the SessionExchange
// WorkerEntrypoint (worker.ts, the service-binding RPC) calls, so the redeem logic lives in one tested place.
// `consume` (bound to consumeSessionExchange with the TRUSTED expectedAudience = APP_BASE_URL — never a
// request header) and `getProfile` (the fresh `user`-row read) are injected via the core deps.

import { PROD_AUTH_BASE_URL } from "../runtime/urls";
import { redeemSessionExchange, type SessionExchangeCoreDeps } from "./session-exchange-core";

// Re-export the shared types so existing importers (session-exchange-deps, issuer-handler) keep their paths.
export type { SessionPrincipal } from "./session-exchange-core";

const PROD_AUTH_HOST = new URL(PROD_AUTH_BASE_URL).host;

/**
 * Is the public POST /session/exchange route RETIRED for this request? In production it is: app. redeems the
 * handoff ticket over the AUTH_SESSION_EXCHANGE service binding (a direct SessionExchange WorkerEntrypoint
 * RPC that never reaches this HTTP route), so the public route has no legitimate prod caller and is removed
 * as an attack surface. The dispatcher (issuer-handler) skips the route when this is true, falling through
 * to a 404. It stays live for LOCAL DEV / PREVIEW, which has no service bindings and reaches auth. by `fetch`
 * to localhost. The host is set by Cloudflare custom-domain routing in prod (the Worker is only reachable via
 * auth.webhook.co) and cannot be spoofed to reach this Worker under a different host — and even if it could,
 * the worst case is serving a single-use, HMAC-signed, audience-bound, atomically-burned ticket.
 */
export function isPublicSessionExchangeRetired(url: URL): boolean {
  return url.host === PROD_AUTH_HOST;
}

/** The injected I/O the route needs — the shared redeem-core deps (consume + getProfile + log). */
export type SessionExchangeRouteDeps = SessionExchangeCoreDeps;

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

export async function handleSessionExchange(
  deps: SessionExchangeRouteDeps,
  request: Request,
): Promise<Response> {
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
  const ticket =
    typeof (body as { ticket?: unknown })?.ticket === "string"
      ? (body as { ticket: string }).ticket
      : "";
  if (!ticket) {
    return jsonResponse(400, { error: "invalid_request", error_description: "ticket is required" });
  }

  const result = await redeemSessionExchange(deps, ticket);
  switch (result.status) {
    case "invalid_grant":
      return jsonResponse(401, {
        error: "invalid_grant",
        error_description: "ticket invalid or expired",
      });
    case "user_missing":
      // The ticket was valid but the user row vanished between mint + redeem (rare). The ticket is already
      // burned; the user re-authenticates. Surface a server error (the principal can't be assembled).
      return jsonResponse(500, {
        error: "server_error",
        error_description: "could not resolve principal",
      });
    case "ok":
      return jsonResponse(200, result.principal);
  }
}
