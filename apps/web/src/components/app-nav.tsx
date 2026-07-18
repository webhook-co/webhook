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
  Inbox,
  Webhook,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

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
export const NAV = {
  overview: { path: "/dashboard", label: "Overview", Icon: Gauge },
  endpoints: { path: "/endpoints", label: "Endpoints", Icon: Webhook },
  events: { path: "/events", label: "Events", Icon: Inbox },
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
    { ...NAV.events, keywords: ["events", "received", "payload", "inspect"] },
    { ...NAV.triggers, keywords: ["agent", "mcp"] },
    { ...NAV.destinations, keywords: ["forward", "target"] },
    { ...NAV.deliveries, keywords: ["attempts", "failures", "retries"] },
    { ...NAV.usage, keywords: ["quota", "metering", "cap"] },
    { ...NAV.billing, keywords: ["plan", "invoice", "subscription", "upgrade"] },
    { ...NAV.credentials, keywords: ["keys", "api key", "tokens", "devices"] },
    { ...NAV.team, keywords: ["members", "invite", "roles"] },
    { ...NAV.audit, keywords: ["logs", "history", "compliance"] },
    { ...NAV.settings, keywords: ["account", "profile", "delete"] },
  ].map(({ path, label, keywords }) => ({ href: orgHref(slug, path), label, keywords }));

/**
 * The ONE nav entry the current path belongs to — so two rows can never both look current, and none can
 * silently look dead.
 *
 * A per-item `startsWith` prefix rule cannot express this: `/endpoints/<id>/events` starts with `/endpoints`,
 * so it would light up Endpoints while the reader is looking at events. Encoding that as two regexes that
 * must be exact inverses (one stops matching exactly where the other starts) is guaranteed drift. Instead one
 * function returns exactly one key, most-specific first, and it is exhaustively table-testable without
 * rendering anything.
 *
 * Both events routes claim the `events` key: the consolidated /events browse AND the per-endpoint
 * /endpoints/<id>/events list. Someone reading events should see "Events" highlighted.
 */
export function activeNavKey(pathname: string, slug: string): keyof typeof NAV | null {
  const prefix = `/org/${slug}`;
  if (!pathname.startsWith(prefix)) return null;
  const path = pathname.slice(prefix.length) || "/";
  if (path === "/events" || path.startsWith("/events/")) return "events";
  if (/^\/endpoints\/[^/]+\/events(\/|$)/.test(path)) return "events";
  for (const [key, entry] of Object.entries(NAV)) {
    if (path === entry.path || path.startsWith(`${entry.path}/`)) return key as keyof typeof NAV;
  }
  return null;
}

export function AppNav({ slug }: { slug: string }) {
  const pathname = usePathname();
  const activeKey = activeNavKey(pathname, slug);

  const item = (
    key: keyof typeof NAV,
    { path, label, Icon }: { path: string; label: string; Icon: typeof Gauge },
    { nested = false, subNav }: { nested?: boolean; subNav?: ReactNode } = {},
  ) => (
    <AppNavItem
      asChild
      active={activeKey === key}
      nested={nested}
      subNav={subNav}
      icon={nested ? undefined : <Icon aria-hidden="true" />}
    >
      <Link href={orgHref(slug, path)}>{label}</Link>
    </AppNavItem>
  );

  return (
    <>
      {/* Overview is the landing after login — a cross-cutting read before you pick a section, so it sits
          above the direction groups (it belongs to neither Inbound nor Outbound). */}
      {item("overview", NAV.overview)}
      {/* Grouped by direction: Inbound is what you receive; Outbound is where you send it and how those
          sends fared. Within Outbound, Destinations (the targets) precede Deliveries (the results) —
          a delivery can't exist before a destination. Each section is a real labeled group (AppNavSection). */}
      <AppNavSection label="Inbound">
        {/* Events sits UNDER Endpoints as a sub-item — a true nested list child, always visible, never
            collapsed: it is the page most readers want, and hiding it behind a disclosure would cost the
            clicks this page exists to remove. */}
        {item("endpoints", NAV.endpoints, {
          subNav: item("events", NAV.events, { nested: true }),
        })}
        {item("triggers", NAV.triggers)}
      </AppNavSection>
      <AppNavSection label="Outbound">
        {item("destinations", NAV.destinations)}
        {item("deliveries", NAV.deliveries)}
      </AppNavSection>
      <AppNavSection label="Account">
        {item("usage", NAV.usage)}
        {item("billing", NAV.billing)}
        {item("credentials", NAV.credentials)}
        {item("team", NAV.team)}
        {item("audit", NAV.audit)}
        {item("settings", NAV.settings)}
      </AppNavSection>
    </>
  );
}
