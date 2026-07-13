"use server";

import { listUserOrgs } from "@webhook-co/db/orgs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { withTenantDb } from "./db";
import { getSessionSecret } from "./env";
import { SESSION_COOKIE, verifySession } from "./session";
import { sessionCookieOptions } from "./session-cookie";
import { signSessionToken, verifySessionToken } from "./session-token";

// The org switcher (Lane 2.7). The session cookie names the acting org, so switching means RE-MINTING it —
// which is the one place that mutates the session's org, and therefore the one place that could point a
// session at an org the user doesn't belong to. So:
//
//   1. The target org is CLIENT INPUT and is treated as such: membership is re-read server-side from the
//      user's own org directory (which can only ever return orgs they're actually in) and the switch is
//      refused otherwise. Nothing is minted on refusal.
//   2. `requireOrgAccess` re-checks membership on EVERY subsequent request anyway, so even a mis-minted
//      cookie could not be used — this is the outer of two gates, not the only one.
//   3. The re-mint carries the ORIGINAL expiry forward rather than starting a fresh TTL. Re-signing with a
//      full 7 days would let anyone keep a session alive indefinitely just by switching orgs.

/**
 * Switch the acting org for the current session. Refuses (and mints nothing) unless the user is a member of
 * the target. Redirects to the dashboard, which re-reads everything under the new org's RLS context.
 */
export async function switchOrgAction(formData: FormData): Promise<void> {
  const session = await verifySession();
  const target = String(formData.get("orgId") ?? "");

  // Already there — don't burn a re-mint (and don't shorten the cookie for nothing).
  if (target && target === session.orgId) redirect("/dashboard");

  let ok = false;
  if (target) {
    // The authorization boundary. listUserOrgs is bounded to the caller's OWN memberships (it reads the
    // user-scoped directory), so an org they don't belong to simply isn't in the list.
    const orgs = await withTenantDb((app) => listUserOrgs(app, session.userId));
    ok = orgs.some((o) => o.orgId === target);
  }
  if (!ok) {
    redirect("/dashboard?org=denied");
  }

  const secret = await getSessionSecret();

  // Carry the CURRENT token's expiry forward. Read it back rather than trusting a fresh TTL — see the note
  // above. A cookie we can't re-verify means no session at all, so send them to sign in rather than mint.
  const current = (await cookies()).get(SESSION_COOKIE)?.value;
  const verified = current ? await verifySessionToken(current, secret) : null;
  if (!verified) redirect("/dashboard?org=denied");

  const remainingSeconds = verified.expiresAt - Math.floor(Date.now() / 1000);
  if (remainingSeconds <= 0) redirect("/dashboard?org=denied");

  const token = await signSessionToken(
    { userId: session.userId, orgId: target, user: session.user },
    secret,
    remainingSeconds,
  );

  (await cookies()).set(SESSION_COOKIE, token, {
    ...sessionCookieOptions(),
    maxAge: remainingSeconds,
  });

  redirect("/dashboard");
}
