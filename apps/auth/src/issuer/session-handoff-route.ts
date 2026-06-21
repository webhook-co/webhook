// A-SX-2b — GET /session/handoff (the producer of the auth.→app. handoff). app. redirects an
// unauthenticated visitor here; this reads the auth. session, mints a single-use exchange ticket bound to
// app., and 302s the browser to app.'s callback carrying the ticket. app.'s server then backchannel-redeems
// it at /session/exchange (A-SX-2a). If there's no session yet, bounce to login (returning here after).
//
// Pure HTTP core: the session, the org resolution, and the mint are injected. Front-running mitigation: the
// ticket rides the redirect URL, so `Referrer-Policy: no-referrer` keeps it out of any Referer header app.'s
// callback emits, and the ticket is single-use + short-TTL + audience-bound (A-SX-1) + unreadable
// cross-origin. CSRF note (GET that mints): a cross-site TOP-LEVEL navigation (window.open / a clicked link
// / a 302 — these carry the SameSite=lax session cookie; a subresource <img>/fetch GET does NOT) can mint a
// ticket against the victim's session, but the response is a 302 whose Location (the only place the ticket
// appears) is unreadable cross-origin, so the attacker can't obtain it; the unused ticket simply expires.

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export interface SessionHandoffRouteDeps {
  /** The live, cookie-derived session user (null = not signed in). */
  getSessionUserId: (request: Request) => Promise<string | null>;
  /** Resolve the user's org for the ticket (getConsentOrg → orgId), or null if they have none. */
  resolveOrg: (userId: string) => Promise<{ orgId: string } | null>;
  /** Mint a single-use exchange ticket for (orgId, userId) bound to app. — returns the opaque handle. */
  mint: (orgId: string, userId: string) => Promise<string>;
  /** Where to sign in (returning here) when there's no session. */
  loginUrl: (returnTo: string) => string;
  /** Build app.'s callback URL carrying the ticket. */
  appCallbackUrl: (ticket: string) => string;
  log?: LogFn;
}

function redirect(location: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store", ...extraHeaders },
  });
}

export async function handleSessionHandoff(
  deps: SessionHandoffRouteDeps,
  request: Request,
): Promise<Response> {
  const userId = await deps.getSessionUserId(request);
  if (!userId) {
    // Not signed in: bounce to login, returning to this exact handoff URL afterwards. Pass only the
    // relative path+query (never the absolute URL) so the reflected return can't be an off-origin redirect.
    const here = new URL(request.url);
    return redirect(deps.loginUrl(`${here.pathname}${here.search}`));
  }

  const org = await deps.resolveOrg(userId);
  if (!org) {
    // Signed in but no org — the signup bootstrap (+ its self-heal) should make this unreachable.
    deps.log?.("session_handoff.no_org", { userId });
    return new Response("no organization for this account", {
      status: 500,
      headers: { "content-type": "text/plain;charset=UTF-8", "cache-control": "no-store" },
    });
  }

  const ticket = await deps.mint(org.orgId, userId);
  deps.log?.("session_handoff.minted", { userId, orgId: org.orgId });
  // no-referrer so the ticket-bearing URL isn't sent as a Referer by app.'s callback page.
  return redirect(deps.appCallbackUrl(ticket), { "referrer-policy": "no-referrer" });
}
