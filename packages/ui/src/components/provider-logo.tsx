import { cn } from "../lib/cn";
import {
  providerBrandColor,
  providerDisplayName,
  providerIconDomain,
} from "../lib/provider-branding";
import { PROVIDER_LOGO_PATHS } from "../lib/provider-logos-data";

// A provider's brand mark for the events surfaces + the marketing wall. Three-tier resolution, best first:
//   1. the official single-path CC0 vector mark (Simple Icons, brand-coloured) where one exists;
//   2. else the brand FAVICON, for brands Simple Icons has dropped over trademark policy (Slack, Twilio,
//      LinkedIn, OpenAI…) — proxied + edge-cached SAME-ORIGIN via `/api/provider-icon?domain=…` so there is
//      NO third-party request at render time and the `img-src 'self'` CSP is unchanged. It is painted as a
//      background-image OVER the monogram tile, so a failed/blocked load simply leaves the monogram showing
//      (no broken-image icon, no client-side error handler — this stays a server-renderable component);
//   3. else (and as the favicon's own fallback) a neutral MONOGRAM tile (1–2 initials).
// A null provider renders nothing (callers show the "—" placeholder). Decorative by default (`aria-hidden`);
// pass `title` for an accessible label.
//
// The monogram uses the design tokens (fg-secondary on surface-sunken — the same a11y-safe combo as the
// inspector badge) rather than the brand colour: a solid brand-colour tile can't guarantee the 4.5:1 text
// contrast for mid-tone hues at this glyph size. The brand colour lives in the official marks instead.

/** Same-origin favicon-proxy route (edge-cached); the app that renders ProviderLogo owns this route. */
const PROVIDER_ICON_ENDPOINT = "/api/provider-icon";

export interface ProviderLogoProps {
  /** The raw provider slug, or null for an event with no detected provider. */
  readonly slug: string | null;
  /** Square px size of the mark/tile. */
  readonly size?: number;
  readonly className?: string;
  /** When set, the mark is announced with this label; otherwise it is decorative (`aria-hidden`). */
  readonly title?: string;
  /**
   * Whether to use the same-origin favicon proxy for a logo-less brand (tier 2). Default `true`. Set `false`
   * on a host that does NOT serve the `/api/provider-icon` route (e.g. the fully-static marketing site), so
   * those providers render the monogram directly instead of emitting a request that would 404.
   */
  readonly faviconFallback?: boolean;
}

/** 1–2 uppercase initials from the provider's display name (the monogram glyph). */
function initialsFor(slug: string): string {
  const words = providerDisplayName(slug, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export function ProviderLogo({
  slug,
  size = 20,
  className,
  title,
  faviconFallback = true,
}: ProviderLogoProps) {
  // No detected provider → render nothing; the caller's display name shows the "—" placeholder.
  if (slug === null) return null;

  const a11y =
    title === undefined
      ? ({ "aria-hidden": true } as const)
      : ({ role: "img", "aria-label": title } as const);
  const mark = PROVIDER_LOGO_PATHS[slug];

  if (mark) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} {...a11y}>
        <path d={mark.path} fill={mark.hex ?? providerBrandColor(slug)} />
      </svg>
    );
  }

  // Monogram tile (token colours, a11y-safe) — always rendered as the base layer. For a brand with no
  // vector mark but a known domain, the favicon is painted OVER it as a background-image: on success it
  // covers the initials; on failure/CSP-block it just doesn't paint, leaving the monogram (no broken img).
  const initials = initialsFor(slug);
  const domain = faviconFallback ? providerIconDomain(slug) : null;
  const faviconStyle =
    domain === null
      ? {}
      : {
          backgroundImage: `url(${PROVIDER_ICON_ENDPOINT}?domain=${encodeURIComponent(domain)})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
        };
  return (
    <span
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center bg-surface-sunken font-semibold text-fg-secondary",
        className,
      )}
      {...a11y}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(3, Math.round(size * 0.2)),
        fontSize: Math.round(size * (initials.length > 1 ? 0.42 : 0.5)),
        lineHeight: 1,
        letterSpacing: "-0.02em",
        ...faviconStyle,
      }}
    >
      {initials}
    </span>
  );
}
