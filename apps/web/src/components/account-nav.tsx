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

const Shield = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

const Buildings = () => (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M4 20V7l6-3v16M10 20h10V11l-6-3M7 10.5h.01M7 14h.01M7 17.5h.01M14 12h.01M14 15h.01M14 18h.01M17 12h.01M17 15h.01M17 18h.01"
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
  { href: "/account/organizations", label: "Organizations", icon: <Buildings /> },
  { href: "/account/security", label: "Login & security", icon: <Shield /> },
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
          // Exact match: `/account/profile` must not light up while you are on `/account/connected-apps`.
          active={pathname === item.href}
        >
          <Link href={item.href}>{item.label}</Link>
        </AppNavItem>
      ))}
    </>
  );
}
