import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/server/session";

// Dev-only: mint a mock session cookie so the gated dashboard is reachable before the real
// auth.→app. handoff (E7) exists. Visit /dev-session to "sign in" as the mock principal.
// Returns 404 in production — this is never a real auth path (it bootstraps no identity).
export function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }
  const res = NextResponse.redirect(new URL("/", request.url));
  res.cookies.set(SESSION_COOKIE, "dev-mock", { path: "/", httpOnly: true, sameSite: "lax" });
  return res;
}
