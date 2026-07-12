import { ProviderLogo } from "@webhook-co/ui";

import type { ProviderEntry } from "@/components/marketing/provider-entries";

/**
 * A provider's brand mark, resolved for a STATIC site. Two tiers, and no third tier that lies:
 *
 *  1. `mark: true` — @webhook-co/ui ships an official single-path CC0 vector (Simple Icons). Rendered
 *     as inline SVG: crisp at any size, no network request.
 *  2. `mark: false` — the brand's favicon, fetched ONCE by `scripts/fetch-provider-icons.mjs` and
 *     committed to `public/providers/<slug>.webp`. A same-origin static file, so there is no
 *     third-party request from a visitor's browser and the `img-src 'self'` CSP is untouched.
 *
 * The dashboard solves tier 2 with a live favicon-proxy Worker route backed by R2 — a mechanism a
 * static export doesn't have, which is why the icons are resolved at build time instead. Passing
 * `faviconFallback={false}` to ProviderLogo keeps it from reaching for that route (it would 404 here).
 *
 * If an icon file is ever missing (someone adds a provider and forgets to re-run the fetch script),
 * `provider-wall.test.tsx` fails and names it — the wall never silently renders a broken image.
 *
 * DECORATIVE by default: the provider's name is rendered as text right next to this, so labelling the
 * mark too would just make a screen reader say every provider twice.
 */
export function ProviderMark({ entry, size = 14 }: { entry: ProviderEntry; size?: number }) {
  if (entry.mark) {
    return (
      <ProviderLogo
        slug={entry.slug}
        size={size}
        faviconFallback={false}
        // `provider-mark` is the hook the dark-mode rule in globals.css uses to neutralise the baked
        // brand hex; `text-fg-secondary` is the colour it neutralises TO (via currentColor).
        className="provider-mark shrink-0 text-fg-secondary"
      />
    );
  }
  return (
    // A plain <img>, not next/image: this is a static export (next/image would need a custom loader),
    // and the file is already an optimised, correctly-sized WebP served from our own origin.
    <img
      src={`/providers/${entry.slug}.webp`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      // Explicit width/height above reserve the box; the wall is 142 items, so without them the
      // page would shift as each icon lands (the Lighthouse gate holds CLS ≤ 0.1).
      // A permanently LIGHT chip. These are raster favicons and can't be recoloured: some are
      // opaque-light (a white box on a dark page) and some are transparent-dark (invisible on one).
      // A small light tile is right in both themes.
      className="shrink-0 rounded-[3px] bg-white"
    />
  );
}
