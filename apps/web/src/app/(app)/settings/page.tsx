import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webhook-co/ui";
import type { Metadata } from "next";

import { logout } from "@/server/auth-actions";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Settings · webhook.co",
};

export default async function SettingsPage() {
  const session = await verifySession();

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-6 p-8">
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
          <CardTitle>API keys &amp; devices</CardTitle>
          <CardDescription>Credential management lands in a later slice.</CardDescription>
        </CardHeader>
      </Card>

      <form action={logout}>
        <Button type="submit" variant="secondary">
          Log out
        </Button>
      </form>
    </div>
  );
}
