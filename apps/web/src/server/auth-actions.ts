"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { LOGIN_URL, SESSION_COOKIE } from "./session";

// dal-gate-allow: session-management — owns the session cookie, scopes no tenant data.

/**
 * Clear the session and return to the sign-in surface. A session-management action (it owns
 * the cookie), so it does not pass through the session gate — there is no tenant data to scope.
 */
export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect(LOGIN_URL);
}
