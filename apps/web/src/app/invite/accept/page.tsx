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

import { acceptInviteAction } from "@/server/invite-actions";
import { verifySession } from "@/server/session";

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
  const [session, sp] = await Promise.all([verifySession(), searchParams]);
  const org = first(sp.org);
  const token = first(sp.token);
  const linkComplete = org !== "" && token !== "";

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
                <input type="hidden" name="token" value={token} />
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
