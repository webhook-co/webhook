import { providerBrandColor, providerDisplayName } from "../lib/provider-branding";
import { PROVIDER_LOGO_PATHS } from "../lib/provider-logos-data";

// A provider's brand mark for the events surfaces + the marketing wall. Renders the official single-path
// CC0 mark (Simple Icons, brand-coloured) where one exists, otherwise a branded MONOGRAM tile (the brand
// colour + 1–2 initials) so every provider — including the ~29 with no clean mark and any future slug —
// renders consistently. A null provider renders nothing (callers show the "—" placeholder via the name).
// Decorative by default (`aria-hidden`); pass `title` for an accessible label.
//
// The product + marketing surfaces are light-only, so a dark mark (e.g. GitHub) reads fine on the light
// background; the dynamic brand colour is the one place an inline style is unavoidable.

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

/** Pick a readable monogram text colour (dark vs white) for a brand-colour tile via relative luminance. */
function readableTextColor(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return "#FFFFFF";
  const n = parseInt(match[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#1A1A1A" : "#FFFFFF";
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

  // Branded monogram fallback (a known/unknown provider with no clean mark).
  const background = providerBrandColor(slug);
  const initials = initialsFor(slug);
  return (
    <span
      className={className}
      {...a11y}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: Math.max(3, Math.round(size * 0.2)),
        backgroundColor: background,
        color: readableTextColor(background),
        fontSize: Math.round(size * (initials.length > 1 ? 0.42 : 0.5)),
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: "-0.02em",
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {initials}
    </span>
  );
}
