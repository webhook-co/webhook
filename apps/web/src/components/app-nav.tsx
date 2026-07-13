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

/**
 * One nav entry. The icon is decorative: the label is the accessible name, so icons are aria-hidden.
 *
 * `path` is relative to the ORG ROOT, not absolute. Every dashboard route now lives under `/org/{slug}/…`, and
 * the slug is only known at render — so the table stores the suffix and `href()` prefixes it. Storing absolute
 * paths here is what would silently break: they would still typecheck, still render, and simply link out of
 * the org.
 */
const NAV = {
  overview: { path: "/dashboard", label: "Overview", Icon: Gauge },
  endpoints: { path: "/endpoints", label: "Endpoints", Icon: Webhook },
  triggers: { path: "/triggers", label: "Triggers", Icon: Zap },
  destinations: { path: "/destinations", label: "Destinations", Icon: Send },
  deliveries: { path: "/deliveries", label: "Deliveries", Icon: Activity },
  usage: { path: "/usage", label: "Usage", Icon: Gauge },
  billing: { path: "/billing", label: "Billing", Icon: CreditCard },
  credentials: { path: "/credentials", label: "Credentials", Icon: KeyRound },
  team: { path: "/team", label: "Team", Icon: Users },
  audit: { path: "/audit", label: "Audit log", Icon: ScrollText },
  settings: { path: "/settings", label: "Settings", Icon: Settings },
} as const;

/** The absolute URL of a nav entry within `slug`'s org. */
export const orgHref = (slug: string, path: string): string => `/org/${slug}${path}`;

/**
 * The ⌘K palette's targets, derived from the SAME nav table. One source of truth: a page that exists in the
 * sidebar but not the palette (or vice-versa) is the kind of drift nobody notices until a user complains.
 * Keywords catch the words people actually type ("keys" → Credentials, "logs" → Audit log).
 */
export const COMMAND_ITEMS = (slug: string) =>
  [
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
  ].map(({ path, label, keywords }) => ({ href: orgHref(slug, path), label, keywords }));

export function AppNav({ slug }: { slug: string }) {
  const pathname = usePathname();

  // Match on the org-rooted href. The old `pathname === href || pathname.startsWith(href + "/")` is still the
  // right shape — but ONLY once href carries the org prefix. Comparing a bare `/endpoints` against
  // `/org/acme/endpoints` matches nothing, so every item would render inactive: a silent, purely visual
  // failure that no type checks and no unit test on the NAV table would catch.
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const item = ({ path, label, Icon }: { path: string; label: string; Icon: typeof Gauge }) => {
    const href = orgHref(slug, path);
    return (
      <AppNavItem asChild active={isActive(href)} icon={<Icon aria-hidden="true" />}>
        <Link href={href}>{label}</Link>
      </AppNavItem>
    );
  };

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
