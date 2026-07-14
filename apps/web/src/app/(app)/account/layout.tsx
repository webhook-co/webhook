import { ThemeToggle } from "@webhook-co/ui";
import type { ReactNode } from "react";

import { AccountMenu } from "@/components/account-menu";
import { AccountNav } from "@/components/account-nav";
import { AppShellClient } from "@/components/app-shell-client";
import { logout } from "@/server/auth-actions";
import { loadMyOrgs } from "@/server/my-orgs";
import { verifySession } from "@/server/session";

/**
 * The ACCOUNT shell — the user-scoped surface, deliberately outside `/org/{slug}`.
 *
 * ── Why this is not a page inside an org ────────────────────────────────────────────────────────────────
 *
 * Everything here belongs to the PERSON, not to an organization: their profile, the OAuth apps THEY have
 * authorized, and the account itself. `loadConnectedApps()` does not even take an `orgId` — it cannot, because
 * the answer does not depend on one.
 *
 * These things used to live in org Settings, and that was a quiet lie. The exact same rows rendered under
 * every org in the switcher, which invites a genuinely dangerous reading: that revoking Claude's access in
 * Acme leaves it connected in your personal org. It does not — there is one grant, and revoking it revokes it
 * everywhere. A user acting on that misunderstanding thinks they have contained something they have not.
 * (`DeleteAccountCard` sat in org Settings for the same reason, which is a stranger one still: a button that
 * erases your entire identity, filed under the settings of one org.)
 *
 * So the URL carries no slug, because the content has no org. The shape of the address now matches the shape
 * of the data.
 *
 * ── The gate is verifySession, NOT requireOrgAccess ─────────────────────────────────────────────────────
 *
 * And that is not a gap: `requireOrgAccess` proves membership OF AN ORG, and there is no org here to be a
 * member of. Asking it would be incoherent. Every read below is bounded by the verified `userId` — which is
 * the correct boundary for user-scoped data, and the only one available.
 * dal-gate-allow: user-scoped shell — gates on verifySession; owns no tenant data (there is no org here).
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  const [session, myOrgs] = await Promise.all([verifySession(), loadMyOrgs()]);

  // Somewhere to go back to. The session's orgId is only a "last acting org" hint — validated against the
  // directory, never trusted — and a user with no orgs at all gets no back link rather than a broken one.
  const home = myOrgs.orgs.find((o) => o.orgId === myOrgs.currentOrgId) ?? myOrgs.orgs[0];

  return (
    <AppShellClient
      sidebar={<AccountNav />}
      sidebarTop={home ? <BackToOrg slug={home.slug} name={home.name} /> : null}
      sidebarFooter={
        <AccountMenu
          name={session.user.name}
          email={session.user.email}
          orgSlug={home?.slug}
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
      {children}
    </AppShellClient>
  );
}

/** The way out. An account page with no route back into the product is a trap. */
function BackToOrg({ slug, name }: { slug: string; name: string }) {
  return (
    <a
      href={`/org/${slug}/dashboard`}
      className="flex items-center gap-2 rounded-control px-2 py-1.5 text-sm text-fg-secondary outline-none transition-colors hover:bg-surface-sunken hover:text-fg focus-visible:shadow-[var(--wh-focus-ring)]"
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-4 shrink-0">
        <path
          d="M10 12.5 5.5 8 10 3.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="min-w-0 truncate">{name}</span>
    </a>
  );
}
