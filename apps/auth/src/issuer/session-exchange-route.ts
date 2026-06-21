// A-SX-2a — POST /session/exchange (the backchannel redeem). app.'s server presents the single-use ticket
// it received via the post-login redirect; this consumes it (atomic single-use, audience-bound to app.) and
// returns the principal { orgId, userId, name, email, image } so app. can establish its own session.
// auth. + app. are separate origins with host-only cookies, so the principal travels server-to-server here,
// never in the browser.
//
// Pure HTTP core: `consume` (bound to consumeSessionExchange with the TRUSTED expectedAudience = APP_BASE_URL
// — never a request header) and `getProfile` (the fresh `user`-row read) are injected. The frozen response
// shape is the C↔E principal payload Lane E's app. session consumes.

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

/** The frozen principal payload — the C↔E session-exchange contract Lane E's app. consumes. */
export interface SessionPrincipal {
  orgId: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
}

export interface SessionExchangeRouteDeps {
  /** Atomically consume the ticket (bound to expectedAudience = APP_BASE_URL). Null = invalid/expired/used. */
  consume: (ticket: string) => Promise<{ userId: string; orgId: string } | null>;
  /** Read the user's display profile fresh (getAuthUserProfile). Null = the user no longer exists. */
  getProfile: (
    userId: string,
  ) => Promise<{ name: string; email: string; image: string | null } | null>;
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

  const consumed = await deps.consume(ticket);
  if (!consumed) {
    // Unknown / expired / already-used / wrong-audience all collapse to null (no oracle).
    return jsonResponse(401, {
      error: "invalid_grant",
      error_description: "ticket invalid or expired",
    });
  }

  const profile = await deps.getProfile(consumed.userId);
  if (!profile) {
    // The ticket was valid but the user row vanished between mint + redeem (rare). The ticket is already
    // burned; the user re-authenticates. Surface a server error (the principal can't be assembled).
    deps.log?.("session_exchange.user_missing", { userId: consumed.userId });
    return jsonResponse(500, {
      error: "server_error",
      error_description: "could not resolve principal",
    });
  }

  deps.log?.("session_exchange.redeemed", { userId: consumed.userId, orgId: consumed.orgId });
  const principal: SessionPrincipal = {
    orgId: consumed.orgId,
    userId: consumed.userId,
    name: profile.name,
    email: profile.email,
    image: profile.image,
  };
  return jsonResponse(200, principal);
}
