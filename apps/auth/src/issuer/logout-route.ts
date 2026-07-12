// GET /logout — end the auth. (IdP) session, not merely app.'s cookie.
//
// This did not exist. app.'s logout could only clear its OWN host-only cookie, so the Better Auth session on
// auth. survived every sign-out — and that session is enough, on its own, to get straight back in:
// `GET /session/handoff` reads it, mints a single-use ticket, and app.'s callback turns that into a fresh
// 7-day dashboard session with ZERO credentials. On a shared machine, "log out" left the next person one
// URL (or one click of "Continue with Google") away from the account.
//
// Better Auth runs with `cookieCache: { enabled: false }`, so its sessions are DB-validated on every read.
// That is what makes this a REAL logout rather than a cosmetic one: signOut deletes the session row, so even
// a copied cookie is dead immediately — we are not relying on the browser to forget anything.
//
// Pure HTTP core: the sign-out and the login URL are injected, so this is testable without a DB or a runtime.

type LogFn = (event: string, fields?: Record<string, unknown>) => void;

export interface LogoutRouteDeps {
  /** Better Auth's sign-out: deletes the session row and returns the clearing `Set-Cookie`. */
  signOut: (request: Request) => Promise<Response>;
  /** Where to land afterwards (the sign-in page). */
  loginUrl: () => string;
  log?: LogFn;
}

/**
 * `Clear-Site-Data: "cookies"` applies to the whole REGISTRABLE DOMAIN, not just this origin — so clearing
 * from auth.webhook.co also takes out app.webhook.co's `__Host-wh_session`. That is deliberate belt-and-
 * braces: app. already deletes its own cookie, but that clearing header was silently rejected by the browser
 * once before (it lacked `Secure` on a `__Host-` cookie), and a logout should not depend on a single header
 * being perfectly formed. `"cache"` additionally evicts the origin's stored responses, so a Back navigation
 * cannot repaint a signed-in page.
 */
const CLEAR_SITE_DATA = '"cookies", "cache"';

function redirect(location: string, setCookies: readonly string[]): Response {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "clear-site-data": CLEAR_SITE_DATA,
  });
  // append, not set: signOut may clear more than one cookie, and each needs its own Set-Cookie line.
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/**
 * A GET that mutates state is CSRF-able: a third-party page can top-level-navigate the victim here, and the
 * `SameSite=Lax` session cookie WOULD ride along, force-logging them out. The impact is nuisance rather than
 * compromise, but refusing it costs one header.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be spoofed by page script. app. → auth. is `same-site`
 * (one registrable domain, different origins); a link on auth. itself is `same-origin`; typing the URL is
 * `none`. Only a genuine third-party origin reports `cross-site`.
 *
 * An ABSENT header (a browser too old to send it) is allowed through: a forced logout is an annoyance, but
 * being unable to log out at all is a security failure, and this must never be the reason someone stays
 * signed in.
 */
function isCrossSiteRequest(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}

export async function handleLogout(deps: LogoutRouteDeps, request: Request): Promise<Response> {
  if (isCrossSiteRequest(request)) {
    deps.log?.("logout.cross_site_refused");
    return new Response("cross-site logout refused", {
      status: 403,
      headers: { "content-type": "text/plain;charset=UTF-8", "cache-control": "no-store" },
    });
  }

  let setCookies: readonly string[] = [];
  try {
    const signedOut = await deps.signOut(request);
    setCookies = signedOut.headers.getSetCookie();
    deps.log?.("logout.signed_out");
  } catch (error) {
    // The session row may still be live, so this is a real failure and is logged as one. We still clear the
    // browser and redirect: leaving the user apparently-signed-in after they asked to leave is worse, and
    // Clear-Site-Data drops the cookies regardless of whether signOut's header ever arrived.
    deps.log?.("logout.sign_out_failed", { error: String(error) });
  }

  return redirect(deps.loginUrl(), setCookies);
}
