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
      {/* Grouped by direction: Inbound is what you receive; Outbound is where you send it and how those
          sends fared. Within Outbound, Destinations (the targets) precede Deliveries (the results) —
          a delivery can't exist before a destination. */}
      <AppNavSection>Inbound</AppNavSection>
      <AppNavItem href="/endpoints" active={isActive("/endpoints")}>
        Endpoints
      </AppNavItem>
      <AppNavItem href="/triggers" active={isActive("/triggers")}>
        Triggers
      </AppNavItem>
      <AppNavSection>Outbound</AppNavSection>
      <AppNavItem href="/destinations" active={isActive("/destinations")}>
        Destinations
      </AppNavItem>
      <AppNavItem href="/deliveries" active={isActive("/deliveries")}>
        Deliveries
      </AppNavItem>
      <AppNavSection>Account</AppNavSection>
      <AppNavItem href="/usage" active={isActive("/usage")}>
        Usage
      </AppNavItem>
      <AppNavItem href="/billing" active={isActive("/billing")}>
        Billing
      </AppNavItem>
      <AppNavItem href="/settings" active={isActive("/settings")}>
        Settings
      </AppNavItem>
    </>
  );
}
