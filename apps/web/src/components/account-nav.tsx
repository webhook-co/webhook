"use client";

import { AppNavItem, AppNavSection } from "@webhook-co/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";

const User = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M4.5 19.5a7.5 7.5 0 0 1 15 0"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const Plug = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M9 3v5m6-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** The account surface's own nav. It is short, and that is the point — this is not a second product. */
const NAV = [
  { href: "/account/profile", label: "Profile", icon: <User /> },
  { href: "/account/connected-apps", label: "Connected apps", icon: <Plug /> },
] as const;

export function AccountNav() {
  const pathname = usePathname();

  return (
    <>
      <AppNavSection>Account</AppNavSection>
      {NAV.map((item) => (
        <AppNavItem
          key={item.href}
          asChild
          icon={item.icon}
          // Exact match: `/account` must not light up while you are on `/account/connected-apps`.
          active={pathname === item.href}
        >
          <Link href={item.href}>{item.label}</Link>
        </AppNavItem>
      ))}
    </>
  );
}
