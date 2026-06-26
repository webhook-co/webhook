"use client";

import { AppNavItem, AppNavSection } from "@webhook-co/ui";
import { usePathname } from "next/navigation";

/**
 * The dashboard sidebar nav. A client component so the active item follows the route (`usePathname`) —
 * the (app) layout is a server component (it awaits the session gate) and can't read the pathname itself.
 * A section is active when the path equals its href or is nested under it (e.g. /endpoints/<id>).
 */
export function AppNav() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  return (
    <>
      <AppNavSection>Workspace</AppNavSection>
      <AppNavItem href="/endpoints" active={isActive("/endpoints")}>
        Endpoints
      </AppNavItem>
      <AppNavSection>Account</AppNavSection>
      <AppNavItem href="/settings" active={isActive("/settings")}>
        Settings
      </AppNavItem>
    </>
  );
}
