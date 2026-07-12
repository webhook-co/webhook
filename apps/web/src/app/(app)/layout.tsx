import { ThemeToggle } from "@webhook-co/ui";
import type { ReactNode } from "react";

import { AccountMenu } from "@/components/account-menu";
import { AppNav } from "@/components/app-nav";
import { AppShellClient } from "@/components/app-shell-client";
import { logout } from "@/server/auth-actions";
import { verifySession } from "@/server/session";

/**
 * The gated dashboard layout. `verifySession()` runs first — an absent session redirects to
 * sign-in before any child renders (the Data-Access-Layer gate; there is no middleware, see
 * ADR-0021). Every route under `(app)` inherits this gate.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await verifySession();

  return (
    <AppShellClient
      homeHref="/"
      sidebar={<AppNav />}
      topBar={
        <>
          <div className="flex-1" />
          <ThemeToggle />
          <AccountMenu name={session.user.name} email={session.user.email} onLogout={logout} />
        </>
      }
    >
      {children}
    </AppShellClient>
  );
}
