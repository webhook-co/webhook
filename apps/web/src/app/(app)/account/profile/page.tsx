import { Card, CardContent, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";

import { DeleteAccountCard } from "@/components/delete-account-card";
import { EditableAvatar } from "@/components/editable-avatar";
import { EditableDisplayName } from "@/components/editable-display-name";
import { updateDisplayNameAction } from "@/server/profile-actions";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Profile · webhook.co",
};

/**
 * Your profile — the things that are true about YOU, not about an organization. Lives at its own
 * `/account/profile` route (the bare `/account` redirects here) so the account area has room to grow more
 * sub-pages without one of them squatting the index.
 *
 * dal-gate-allow: user-scoped — gates on verifySession; reads no tenant data (there is no org here).
 */
export default async function AccountProfilePage() {
  const session = await verifySession();

  return (
    <PageContainer size="narrow" gap="gap-6">
      {/* The page heading IS the "Profile" label — the identity card below carries no redundant title. */}
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Profile</h1>
        <p className="leading-snug text-fg-secondary">
          How you appear to your teammates, across every organization you belong to.
        </p>
      </div>

      <Card>
        {/* CardContent defaults to `pt-0` (it expects a CardHeader above it); this card has none, so restore
            the top padding or the identity row is cramped against the card's top edge. */}
        <CardContent className="flex flex-col gap-4 pt-6">
          <EditableDisplayName
            name={session.user.name}
            email={session.user.email}
            onSave={updateDisplayNameAction}
            avatar={
              <EditableAvatar name={session.user.name} email={session.user.email} size={48} />
            }
          />
          {/* The card shows your email next to an "Edit" button that only edits your NAME — which reads as a
              broken control rather than a deliberate scope. Changing an email is a verified ceremony (a code
              to the current address, other sessions revoked), so it lives on Login & security and cannot
              sensibly be an inline field here. Say where it went rather than leave the reader poking at it. */}
          <p className="border-t border-hairline pt-4 text-xs text-fg-faint">
            Your email is used to sign in, so it changes over on{" "}
            <Link
              href="/account/security"
              className="text-fg-secondary underline underline-offset-2 hover:text-fg"
            >
              Login &amp; security
            </Link>
            {" — we verify the new address before it takes effect."}
          </p>
        </CardContent>
      </Card>

      {/* Deleting your account is a fact about YOU — it erases your identity across every org you are in. It
          lived in ONE org's settings page, which is a strange place for it: the button that ends everything,
          filed under the settings of one workspace. */}
      <DeleteAccountCard />
    </PageContainer>
  );
}
