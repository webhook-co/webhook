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

import { redeemSessionExchange, type SessionExchangeCoreDeps } from "./session-exchange-core";

// Re-export the shared types so existing importers (session-exchange-deps, issuer-handler) keep their paths.
export type { SessionPrincipal } from "./session-exchange-core";

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
