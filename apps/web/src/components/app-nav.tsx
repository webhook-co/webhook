"use client";

import { AppNavItem, AppNavSection } from "@webhook-co/ui";
import {
  Activity,
  CreditCard,
  Gauge,
  KeyRound,
  ScrollText,
  Send,
  Settings,
  Users,
  Webhook,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The dashboard sidebar nav. A client component so the active item follows the route (`usePathname`) —
 * the (app) layout is a server component (it awaits the session gate) and can't read the pathname itself.
 * A section is active when the path equals its href or is nested under it (e.g. /endpoints/<id>).
 *
 * Every item routes through `next/link` (via AppNavItem's `asChild`). It used to emit bare `<a>` tags, which
 * meant every sidebar click was a FULL DOCUMENT NAVIGATION — tearing down and re-fetching the whole app
 * shell, and throwing away client state — instead of a client-side route change.
 */

/** One nav entry. The icon is decorative: the label is the accessible name, so icons are aria-hidden. */
const NAV = {
  overview: { href: "/dashboard", label: "Overview", Icon: Gauge },
  endpoints: { href: "/endpoints", label: "Endpoints", Icon: Webhook },
  triggers: { href: "/triggers", label: "Triggers", Icon: Zap },
  destinations: { href: "/destinations", label: "Destinations", Icon: Send },
  deliveries: { href: "/deliveries", label: "Deliveries", Icon: Activity },
  usage: { href: "/usage", label: "Usage", Icon: Gauge },
  billing: { href: "/billing", label: "Billing", Icon: CreditCard },
  credentials: { href: "/credentials", label: "Credentials", Icon: KeyRound },
  team: { href: "/team", label: "Team", Icon: Users },
  audit: { href: "/audit", label: "Audit log", Icon: ScrollText },
  settings: { href: "/settings", label: "Settings", Icon: Settings },
} as const;

/**
 * The ⌘K palette's targets, derived from the SAME nav table. One source of truth: a page that exists in the
 * sidebar but not the palette (or vice-versa) is the kind of drift nobody notices until a user complains.
 * Keywords catch the words people actually type ("keys" → Credentials, "logs" → Audit log).
 */
export const COMMAND_ITEMS = [
  { ...NAV.overview, keywords: ["home", "dashboard", "stats"] },
  { ...NAV.endpoints, keywords: ["ingest", "url", "webhook"] },
  { ...NAV.triggers, keywords: ["agent", "mcp"] },
  { ...NAV.destinations, keywords: ["forward", "target"] },
  { ...NAV.deliveries, keywords: ["attempts", "failures", "retries"] },
  { ...NAV.usage, keywords: ["events", "quota"] },
  { ...NAV.billing, keywords: ["plan", "invoice", "subscription", "upgrade"] },
  { ...NAV.credentials, keywords: ["keys", "api key", "tokens", "devices"] },
  { ...NAV.team, keywords: ["members", "invite", "roles"] },
  { ...NAV.audit, keywords: ["logs", "history", "compliance"] },
  { ...NAV.settings, keywords: ["account", "profile", "delete"] },
].map(({ href, label, keywords }) => ({ href, label, keywords }));

export function AppNav() {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const item = ({ href, label, Icon }: { href: string; label: string; Icon: typeof Gauge }) => (
    <AppNavItem asChild active={isActive(href)} icon={<Icon aria-hidden="true" />}>
      <Link href={href}>{label}</Link>
    </AppNavItem>
  );

  return (
    <>
      {/* Overview is the landing after login — a cross-cutting read before you pick a section, so it sits
          above the direction groups (it belongs to neither Inbound nor Outbound). */}
      {item(NAV.overview)}
      {/* Grouped by direction: Inbound is what you receive; Outbound is where you send it and how those
          sends fared. Within Outbound, Destinations (the targets) precede Deliveries (the results) —
          a delivery can't exist before a destination. */}
      <AppNavSection>Inbound</AppNavSection>
      {item(NAV.endpoints)}
      {item(NAV.triggers)}
      <AppNavSection>Outbound</AppNavSection>
      {item(NAV.destinations)}
      {item(NAV.deliveries)}
      <AppNavSection>Account</AppNavSection>
      {item(NAV.usage)}
      {item(NAV.billing)}
      {item(NAV.credentials)}
      {item(NAV.team)}
      {item(NAV.audit)}
      {item(NAV.settings)}
    </>
  );
}
