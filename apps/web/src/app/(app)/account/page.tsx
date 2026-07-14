import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageContainer,
} from "@webhook-co/ui";
import type { Metadata } from "next";

import { DeleteAccountCard } from "@/components/delete-account-card";
import { UserAvatar } from "@/components/user-avatar";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Account · webhook.co",
};

/**
 * Your account — the things that are true about YOU, not about an organization.
 *
 * dal-gate-allow: user-scoped — gates on verifySession; reads no tenant data (there is no org here).
 */
export default async function AccountPage() {
  const session = await verifySession();

  return (
    <PageContainer size="narrow" gap="gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Account</h1>
        <p className="leading-snug text-fg-secondary">
          These settings are about you, and apply across every organization you belong to.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>How you appear to your teammates.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <UserAvatar name={session.user.name} email={session.user.email} size={48} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate font-medium text-fg">{session.user.name}</span>
            <span className="truncate text-sm text-fg-secondary">{session.user.email}</span>
          </div>
        </CardContent>
      </Card>

      {/* Deleting your account is a fact about YOU — it erases your identity across every org you are in. It
          lived in ONE org's settings page, which is a strange place for it: the button that ends everything,
          filed under the settings of one workspace. */}
      <DeleteAccountCard />
    </PageContainer>
  );
}
