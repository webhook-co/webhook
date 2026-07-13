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
import { RenameOrgCard } from "@/components/rename-org-card";
import { logout } from "@/server/auth-actions";
import { requireOrgAccess } from "@/server/org-access";
import { renameOrgAction } from "@/server/org-actions";

export const metadata: Metadata = {
  title: "Settings · webhook.co",
};

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireOrgAccess(slug, "/settings");
  // The org's authoritative display name comes from the SAME directory read that proved membership (on
  // `session.name`) — never inferred from the slug. An earlier version fell back to the slug when a second,
  // redundant directory read didn't contain the org; that fallback could seed the rename form's Name field
  // with the slug and, on submit, persist the slug AS the display name. Reading the one authoritative value
  // removes both the extra query and the corruption path.
  // Renaming changes the org's public address and retires the old one forever, so it is owner/admin only —
  // enforced server-side in renameOrg; the card is read-only for a plain member.
  const canRename = session.role === "owner" || session.role === "admin";

  return (
    <PageContainer size="narrow" gap="gap-6">
      <h1 className="text-2xl font-semibold tracking-heading text-fg">Settings</h1>

      <RenameOrgCard
        slug={session.slug}
        name={session.name}
        rename={renameOrgAction.bind(null, session.slug)}
        canRename={canRename}
      />

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
            <a href={`/org/${session.slug}/settings/connected-apps`}>Manage connected apps</a>
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

      <DeleteOrgCard slug={session.slug} />
      <DeleteAccountCard />
    </PageContainer>
  );
}
