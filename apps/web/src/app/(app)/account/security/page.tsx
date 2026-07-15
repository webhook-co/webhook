import {
  Banner,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageContainer,
  PageHeader,
} from "@webhook-co/ui";
import type { Metadata } from "next";

import { EmailChangeForm } from "@/components/email-change-form";
import { LoginMethodsManager } from "@/components/login-methods-manager";
import { commitEmailChangeAction, startEmailChangeAction } from "@/server/email-change-actions";
import { disconnectLoginMethodAction, loadLoginMethods } from "@/server/login-methods-actions";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Login & security · webhook.co",
};

/**
 * Login & security — the email on your account and the social sign-ins linked to it. User-scoped (facts about
 * YOU, not an org), so it lives under /account.
 *
 * dal-gate-allow: user-scoped — gates on verifySession; reads no tenant data (identity realm only, over RPC).
 */
export default async function AccountSecurityPage() {
  const session = await verifySession();
  const methods = await loadLoginMethods();

  return (
    <PageContainer size="narrow" gap="gap-6">
      <PageHeader
        title="Login & security"
        description="The email on your account, and how you sign in."
      />

      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <CardDescription>
            Change the email used for sign-in and account notices. We verify it with a code to your
            current address, and sign you out of other sessions when it changes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmailChangeForm
            currentEmail={session.user.email}
            start={startEmailChangeAction}
            commit={commitEmailChangeAction}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Login methods</CardTitle>
          <CardDescription>The social sign-ins linked to your account.</CardDescription>
        </CardHeader>
        <CardContent>
          {methods.status === "ok" ? (
            <LoginMethodsManager
              initialMethods={methods.methods}
              hasMagicLink={methods.hasMagicLink}
              disconnect={disconnectLoginMethodAction}
            />
          ) : (
            <Banner tone="warn">
              Login methods are temporarily unavailable. Please try again shortly.
            </Banner>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
