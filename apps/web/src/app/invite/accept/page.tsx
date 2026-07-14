import {
  Banner,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@webhook-co/ui";
import type { Metadata } from "next";

import { redirect } from "next/navigation";

import { acceptInviteAction } from "@/server/invite-actions";
import { readInviteCookie } from "@/server/invite-cookie";
import { getSessionOrNull } from "@/server/session";

export const metadata: Metadata = {
  title: "Accept invite · webhook.co",
};

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

/**
 * The invite-accept confirmation page. Reached from the emailed/shared link (`?org=&token=`). It needs a
 * session — the accepting user is JOINING, not yet a member — and `verifySession()` redirects to sign-in if
 * absent (a signed-in user is the common path; a not-yet-returned `returnTo` through login is a known gap,
 * lanes 1.1 / 2.4). The user confirms with a single button; `acceptInviteAction` matches the invite against
 * their OWN verified email (never anything on this page) and redirects to /dashboard with the outcome.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string | string[]; token?: string | string[] }>;
}) {
  const [session, sp] = await Promise.all([getSessionOrNull(), searchParams]);
  const org = first(sp.org);
  const urlToken = first(sp.token);

  // A brand-new invitee has no session. A Server Component render CANNOT set a cookie (Next forbids it), so
  // hand off to the /invite/start ROUTE HANDLER, which stashes {org, token} in the encrypted cookie and
  // bounces to login. Forward the token here (same-origin) — it lands in the cookie there, never in an
  // auth-origin URL.
  if (!session) {
    const q = new URLSearchParams();
    if (org) q.set("org", org);
    if (urlToken) q.set("token", urlToken);
    redirect(`/invite/start?${q.toString()}`);
  }

  // Signed in: the token is in the URL (an already-signed-in user clicked the link directly) or in the cookie
  // (a returned new invitee). The action re-reads the cookie authoritatively (invite-actions), so we only need
  // to know whether a token EXISTS to decide what to render.
  const cookie = urlToken ? null : await readInviteCookie();
  const cookieToken = cookie && cookie.org === org ? cookie.token : "";
  const linkComplete = org !== "" && (urlToken !== "" || cookieToken !== "");

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
      <Card>
        <CardHeader>
          <CardTitle>Join this organization</CardTitle>
          <CardDescription>
            {linkComplete
              ? "You've been invited to a team on webhook.co. Accept to join it."
              : "This invite link is incomplete or has been altered."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {linkComplete ? (
            <>
              <p className="text-sm text-fg-secondary">
                You&apos;re signed in as{" "}
                <span className="font-medium text-fg">{session.user.email}</span>. The invite only
                works if it was sent to this address.
              </p>
              <form action={acceptInviteAction} className="flex flex-col gap-3">
                <input type="hidden" name="org" value={org} />
                {/* Only the URL path (an already-signed-in user) puts the token in the form; the returned-new-
                    invitee path keeps it in the encrypted cookie, which the action reads server-side. */}
                {urlToken ? <input type="hidden" name="token" value={urlToken} /> : null}
                <Button type="submit">Accept invite</Button>
              </form>
            </>
          ) : (
            <Banner tone="danger">
              Ask whoever invited you to send the link again. Nothing was changed.
            </Banner>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
