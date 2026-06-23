// A-SX (service-binding follow-up) — the REUSABLE redeem core for the auth.→app. session handoff. Both the
// public `POST /session/exchange` HTTP route (session-exchange-route.ts) AND the SessionExchange
// WorkerEntrypoint (worker.ts, called by app. over a Cloudflare service binding) redeem through here, so the
// consume→profile→principal logic lives in exactly one tested place.
//
// The ticket is the single-use, audience-bound credential: `consume` atomically burns it (audience-bound to
// app. in the deps), then `getProfile` reads the user's display profile fresh. The result is a tagged union so
// each caller maps it to its own surface — the HTTP route to status codes (401/500/200), the RPC to
// `SessionPrincipal | null` (the user-missing edge collapses to null; the ticket is already burned and the
// user re-authenticates).

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

/** The frozen principal payload — the C↔E session-exchange contract Lane E's app. consumes. */
export interface SessionPrincipal {
  orgId: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
}

export interface SessionExchangeCoreDeps {
  /** Atomically consume the ticket (bound to expectedAudience = APP_BASE_URL). Null = invalid/expired/used. */
  consume: (ticket: string) => Promise<{ userId: string; orgId: string } | null>;
  /** Read the user's display profile fresh (getAuthUserProfile). Null = the user no longer exists. */
  getProfile: (
    userId: string,
  ) => Promise<{ name: string; email: string; image: string | null } | null>;
  log?: LogFn;
}

/**
 * The redeem outcome:
 *  - `ok`            — the ticket burned + the principal assembled.
 *  - `invalid_grant` — unknown / expired / already-used / wrong-audience (all collapse here — no oracle).
 *  - `user_missing`  — the ticket was valid but the user row vanished between mint + redeem (the ticket is
 *                      already burned; the principal can't be assembled).
 */
export type SessionExchangeResult =
  | { status: "ok"; principal: SessionPrincipal }
  | { status: "invalid_grant" }
  | { status: "user_missing" };

/**
 * The single redeem path: consume the ticket, then read the profile and assemble the principal. Assumes the
 * caller already validated that `ticket` is a non-empty string (the HTTP route does its own 415/400 parse
 * first; the RPC guards a non-string arg before calling).
 */
export async function redeemSessionExchange(
  deps: SessionExchangeCoreDeps,
  ticket: string,
): Promise<SessionExchangeResult> {
  const consumed = await deps.consume(ticket);
  if (!consumed) {
    // Unknown / expired / already-used / wrong-audience all collapse to null (no oracle).
    return { status: "invalid_grant" };
  }

  const profile = await deps.getProfile(consumed.userId);
  if (!profile) {
    deps.log?.("session_exchange.user_missing", { userId: consumed.userId });
    return { status: "user_missing" };
  }

  deps.log?.("session_exchange.redeemed", { userId: consumed.userId, orgId: consumed.orgId });
  return {
    status: "ok",
    principal: {
      orgId: consumed.orgId,
      userId: consumed.userId,
      name: profile.name,
      email: profile.email,
      image: profile.image,
    },
  };
}
