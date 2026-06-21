import { NextResponse } from "next/server";

import { getSessionSecret } from "@/server/env";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, type Session } from "@/server/session";
import { signSessionToken } from "@/server/session-token";

// dal-gate-allow: dev-only pre-auth bootstrap — 404 in prod, mints no real identity.
//
// Dev-only: mint a session for a fixed mock principal so the gated dashboard is reachable without
// running the full auth.→app. handoff locally. Now that the gate VERIFIES the cookie value (E7),
// this mints a real signed token (the dev secret) rather than the old opaque "dev-mock" string.
// Returns 404 in production — there is no production path that sets the session cookie except the
// A-SX handoff, so prod is fail-closed.

const DEV_PRINCIPAL: Session = {
  userId: "usr_dev_local",
  orgId: "org_dev_local",
  user: { name: "Dana (dev)", email: "dana@dev.local", image: null },
};

export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }
  const token = await signSessionToken(
    DEV_PRINCIPAL,
    await getSessionSecret(),
    SESSION_TTL_SECONDS,
  );
  const res = NextResponse.redirect(new URL("/", request.url));
  res.cookies.set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // Dev-only route (404s in prod above), so the cookie is only ever set over http://localhost.
    secure: false,
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
