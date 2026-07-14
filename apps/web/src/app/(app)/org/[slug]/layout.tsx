import { ThemeToggle } from "@webhook-co/ui";
import type { ReactNode } from "react";

import { AccountMenu } from "@/components/account-menu";
import { AppNav } from "@/components/app-nav";
import { AppShellClient } from "@/components/app-shell-client";
import { OrgCommandPalette } from "@/components/org-command-palette";
import { OrgSwitcher } from "@/components/org-switcher";
import { logout } from "@/server/auth-actions";
import { loadMyOrgs } from "@/server/my-orgs";
import { requireOrgAccess } from "@/server/org-access";

/**
 * The gated dashboard shell, now rooted at `/org/{slug}`.
 *
 * `requireOrgAccess(slug)` runs first: it resolves the URL's slug inside the caller's OWN directory, so
 * resolution and the membership check are the same operation, and a slug they don't belong to 404s (never
 * 403 — that would be an enumeration oracle, and never a sign-in redirect — that would infinite-loop on a
 * bookmarked foreign-org URL). There is no middleware (ADR-0021), so this IS the gate.
 *
 * It is necessary but NOT sufficient: Next renders a layout and its page CONCURRENTLY, so this redirect does
 * not prevent a page's tenant query from having already run. Every page gates for itself too (ADR-0116);
 * `requireOrgAccess` is memoized per request, so that costs one directory read, not one per component.
 *
 * No `subPath` here, deliberately. The layout does not know the path below it — only the page does — so
 * canonicalising a mis-cased or retired slug is the PAGE's job. The layout's job is to refuse.
 */
export default async function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [access, myOrgs] = await Promise.all([requireOrgAccess(slug), loadMyOrgs()]);

  return (
    // NO `homeHref` — and therefore no wordmark. The ORG PICKER takes the top-left corner instead, which is
    // where every modern SaaS sidebar puts it, and for a reason: "which organization am I in?" is the question
    // you need answered before any other, while a wordmark answers a question nobody was asking (the user
    // knows what site they are on). The account menu moves to the bottom-left, out of the toolbar, because
    // "who am I signed in as" is a fact about the session, not an action on this page.
    <AppShellClient
      sidebar={<AppNav slug={access.slug} />}
      sidebarTop={
        <OrgSwitcher
          orgs={myOrgs.orgs}
          currentOrgId={access.orgId}
          // From the GATE, not from the list: `loadMyOrgs` degrades to [] if its read blips, and the one label
          // that must always be right is the org you are actually looking at.
          currentName={access.name}
          currentSlug={access.slug}
        />
      }
      sidebarFooter={
        <AccountMenu
          name={access.user.name}
          email={access.user.email}
          // Passed explicitly. The menu used to read the slug off the URL, which quietly breaks the moment it
          // is mounted anywhere without one — as it now is, on /account.
          orgSlug={access.slug}
          onLogout={logout}
        />
      }
      topBar={
        <>
          <div className="flex-1" />
          <ThemeToggle />
        </>
      }
    >
      <OrgCommandPalette />
      {children}
    </AppShellClient>
  );
}
