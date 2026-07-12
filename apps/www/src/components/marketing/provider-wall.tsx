import { cn, ProviderLogo } from "@webhook-co/ui";

import { PROVIDER_ENTRIES } from "@/components/marketing/provider-entries";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { container, sectionPad } from "@/lib/styles";

/**
 * Every provider we can verify, named and marked. This is the most credible thing the site owns and it
 * was invisible: the adapter registry shipped 142 providers while the homepage said "Stripe & GitHub
 * today, more soon".
 *
 * THE MARKS. `ProviderLogo` resolves a brand three ways, best first: the official single-path CC0
 * vector mark (Simple Icons — 78 of the 142 have one), else a brand favicon, else a neutral monogram
 * tile. We pass `faviconFallback={false}` because that middle tier is a SAME-ORIGIN PROXY ROUTE
 * (`/api/provider-icon`) which only the dashboard serves — this site is a static export, so asking for
 * it would just 404. The other 64 therefore render the monogram, which uses design tokens rather than
 * a brand-colour tile: a solid brand colour can't hold 4.5:1 contrast at this glyph size.
 *
 * The marks are INLINE SVG paths, so there is no network request at render time: the `img-src 'self'`
 * CSP is untouched and a visitor's browser makes no third-party call. The marketing site is light-only
 * (see layout.tsx), so the baked brand colours always sit on a light surface and stay legible.
 *
 * Marks are DECORATIVE (`aria-hidden`, the ProviderLogo default): the provider's name is right there
 * as text, so labelling the mark too would just make a screen reader say everything twice.
 *
 * The list is generated from the registry and pinned to it by `provider-wall.test.tsx` — so the wall
 * cannot drift from what the code can actually verify: add an adapter, the wall grows.
 */
export function ProviderWall() {
  return (
    <section aria-labelledby="providers" className={cn(container, sectionPad)}>
      <div className="mb-8 max-w-[60ch]">
        <SectionEyebrow className="mb-4">verification</SectionEyebrow>
        <h2
          id="providers"
          className="mb-4 text-[clamp(26px,3.4vw,36px)] leading-tight font-semibold tracking-heading text-balance text-fg"
        >
          {PROVIDER_ENTRIES.length} providers, built in
        </h2>
        <p className="text-md text-pretty text-fg-secondary">
          Point any of these at a webhook.co endpoint and its signature is checked on arrival — you
          don&rsquo;t write the verification code, and you don&rsquo;t store the secret in your app.
          When a signature fails, you get the reason, not a boolean.
        </p>
      </div>

      {/* A plain list: crawlable, zero client JS, and it reads as what it is — an inventory. */}
      <ul className="flex flex-wrap gap-x-2 gap-y-2">
        {PROVIDER_ENTRIES.map(({ slug, name }) => (
          <li
            key={slug}
            className="inline-flex items-center gap-1.5 rounded-control border border-hairline bg-surface py-1 pr-2.5 pl-2 font-mono text-xs text-fg-secondary"
          >
            <ProviderLogo slug={slug} size={14} faviconFallback={false} className="rounded-[3px]" />
            {name}
          </li>
        ))}
      </ul>
    </section>
  );
}
