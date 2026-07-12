"use server";

import { cookies } from "next/headers";
import { sessionCookieOptions } from "./session-cookie";
import { redirect } from "next/navigation";

import { LOGOUT_URL, SESSION_COOKIE } from "./session";

// dal-gate-allow: session-management — owns the session cookie, scopes no tenant data.

/**
 * Clear the session and return to the sign-in surface. A session-management action (it owns
 * the cookie), so it does not pass through the session gate — there is no tenant data to scope.
 */
export async function logout() {
  // Clear with the SAME attributes it was set with. This is load-bearing, not tidiness: Next's
  // `delete` forwards these options onto the clearing `Set-Cookie`, and a `__Host-` cookie without
  // `Secure` is rejected outright by the browser (RFC 6265bis §4.1.3) — the header would be dropped and
  // the session would survive logout entirely.
  (await cookies()).delete({ name: SESSION_COOKIE, ...sessionCookieOptions() });
  redirect(LOGOUT_URL);
}
