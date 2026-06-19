"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { LOGIN_URL, SESSION_COOKIE } from "./session";

/**
 * Clear the session and return to the sign-in surface. A session-management action (it owns
 * the cookie), so it does not pass through {@link verifySession} — there is no tenant data to
 * scope.
 */
export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect(LOGIN_URL);
}
