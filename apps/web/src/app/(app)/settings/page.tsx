import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageContainer,
} from "@webhook-co/ui";
import type { Metadata } from "next";

import { DeleteAccountCard } from "@/components/delete-account-card";
import { DeleteOrgCard } from "@/components/delete-org-card";
import { logout } from "@/server/auth-actions";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Settings · webhook.co",
};

export default async function SettingsPage() {
  const session = await verifySession();

  return (
    <PageContainer size="narrow" gap="gap-6">
      <h1 className="text-2xl font-semibold tracking-heading text-fg">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>You&apos;re signed in to webhook.co.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <span className="font-medium text-fg">{session.user.name}</span>
          <span className="text-sm text-fg-secondary">{session.user.email}</span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected apps</CardTitle>
          <CardDescription>
            Apps you&apos;ve authorized (like Claude or Cursor) to access your account over OAuth.
            Review them and revoke access anytime.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="secondary">
            <a href="/settings/connected-apps">Manage connected apps</a>
          </Button>
        </CardContent>
      </Card>

      {/* Deliberate product choice: log out is the red danger button (like "Delete endpoint"), not a
          neutral secondary — it's the most consequential control on this page and reads as session-ending. */}
      <form action={logout}>
        <Button type="submit" variant="danger">
          Log out
        </Button>
      </form>

      <DeleteOrgCard />
      <DeleteAccountCard />
    </PageContainer>
  );
}
