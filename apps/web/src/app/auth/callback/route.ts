import { sanitizeReturnPath } from "@webhook-co/shared";
import { NextResponse } from "next/server";
import { sessionCookieOptions } from "@/server/session-cookie";

import { getSessionSecret } from "@/server/env";
import { exchangeTicket } from "@/server/session-exchange";
import { signSessionToken } from "@/server/session-token";
import { LOGIN_URL, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/server/session";

// dal-gate-allow: pre-auth handoff — redeems the A-SX ticket and ESTABLISHES the session. It owns the
// session cookie and reads no tenant data, so it does not pass through the session gate.

// The callback always runs per-request (it reads the ticket query param + sets a cookie).
export const dynamic = "force-dynamic";

/**
 * The `auth.`→`app.` session handoff landing (ADR-0033). auth. redirects here with a single-use ticket;
 * we backchannel-redeem it for the session principal, set our own host-only signed session cookie, and
 * land on the dashboard **without the ticket in the URL** (no history/referer leak). Any failure —
 * absent/invalid/expired/replayed ticket, or a transient exchange error — sends the user to sign in.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const ticket = url.searchParams.get("ticket");
  const login = new URL(LOGIN_URL, url.origin);

  // A failed handoff must land on a real sign-in FORM, not silently re-enter the handoff. auth.'s /login now
  // resumes an already-signed-in user by bouncing them to /session/handoff — so a bare redirect back to
  // /login here would loop forever whenever the ticket cannot be redeemed (expired, replayed, exchange down):
  // login → handoff → ticket → callback fails → login → … This param is the loop breaker; /login shows the
  // form when it is present. Its VALUE is deliberately generic — it is a signal to our own page, not a
  // diagnosis for the user, and never carries the ticket or a raw error.
  const failed = new URL(login);
  failed.searchParams.set("error", "handoff_failed");
  // Preserve the invitee's return path across a FAILED redeem: /login shows the form (error flag) and, once
  // they re-authenticate, resumes them to the return path instead of dropping them on `/`. Same-origin
  // validated; a bad/absent next simply isn't carried.
  const failNext = sanitizeReturnPath(url.searchParams.get("next"), url.origin);
  if (failNext) {
    failed.searchParams.set("redirect", `/session/handoff?next=${encodeURIComponent(failNext)}`);
  }

  if (!ticket) {
    return NextResponse.redirect(login);
  }

  let token: string;
  try {
    const session = await exchangeTicket(ticket);
    token = await signSessionToken(session, await getSessionSecret(), SESSION_TTL_SECONDS);
    // Scrubbed (no ticket/token/PII) — confirms the handoff completed; pairs with auth.'s
    // session_handoff.minted + the /session/exchange request log for an end-to-end trace.
    console.log(JSON.stringify({ message: "auth.callback.session_established" }));
  } catch (error) {
    // A failed redeem (expired/replayed/invalid ticket, or a transient exchange error) sends the user back
    // to sign in. Log the reason (no ticket value) so a broken handoff is diagnosable, not silent.
    console.warn(
      JSON.stringify({ message: "auth.callback.exchange_failed", error: String(error) }),
    );
    return NextResponse.redirect(failed);
  }

  // Land on the validated opt-in return path (an invitee's `next=/invite/accept?org=…`) or, by default, the
  // dashboard `/`. `next` is re-validated same-origin here — the handoff already checked it, but this endpoint
  // must never redirect off-origin on its own authority. The ticket never enters the final URL (no history
  // leak); `next` is a non-secret same-origin path.
  const next = sanitizeReturnPath(url.searchParams.get("next"), url.origin) ?? "/";
  const response = NextResponse.redirect(new URL(next, url.origin));
  response.cookies.set(SESSION_COOKIE, token, {
    ...sessionCookieOptions(),
    maxAge: SESSION_TTL_SECONDS,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
