import { cn } from "../lib/cn";
import { providerBrandColor, providerDisplayName } from "../lib/provider-branding";
import { PROVIDER_LOGO_PATHS } from "../lib/provider-logos-data";

// A provider's brand mark for the events surfaces + the marketing wall. Renders the official single-path
// CC0 mark (Simple Icons, brand-coloured) where one exists, otherwise a neutral MONOGRAM tile (1–2
// initials on the surface-sunken token) so every provider — including the ~29 with no clean mark and any
// future slug — renders consistently. A null provider renders nothing (callers show the "—" placeholder).
// Decorative by default (`aria-hidden`); pass `title` for an accessible label.
//
// The monogram uses the design tokens (fg-secondary on surface-sunken — the same a11y-safe combo as the
// inspector badge) rather than the brand colour: a solid brand-colour tile can't guarantee the 4.5:1 text
// contrast for mid-tone hues at this glyph size. The brand colour lives in the official marks instead.

export interface ProviderLogoProps {
  /** The raw provider slug, or null for an event with no detected provider. */
  readonly slug: string | null;
  /** Square px size of the mark/tile. */
  readonly size?: number;
  readonly className?: string;
  /** When set, the mark is announced with this label; otherwise it is decorative (`aria-hidden`). */
  readonly title?: string;
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

export function ProviderLogo({ slug, size = 20, className, title }: ProviderLogoProps) {
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

  // Neutral monogram fallback (a known/unknown provider with no clean mark) — token colours, a11y-safe.
  const initials = initialsFor(slug);
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
      }}
    >
      {initials}
    </span>
  );
}
