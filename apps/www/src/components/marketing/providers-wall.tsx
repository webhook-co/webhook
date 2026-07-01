import { cn, PROVIDER_BRANDING, ProviderLogo, providerDisplayName } from "@webhook-co/ui";

import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { sectionPad } from "@/lib/styles";

// The "supported providers" proof wall. Every provider the engine verifies out of the box, rendered as
// a flex-wrapped grid of brand-marked pills (the official mark where one exists, a branded monogram
// otherwise — see @webhook-co/ui's ProviderLogo). The count is derived from the branding map (the same
// source the product uses), so it stays truthful as the registry grows. Brand marks are inline SVG, so
// the `img-src 'self' data:` CSP is satisfied with no external image request.

const PROVIDER_SLUGS = Object.keys(PROVIDER_BRANDING);

export function ProvidersWall() {
  return (
    <section aria-labelledby="providers-title" className={sectionPad}>
      <div className="mx-auto flex max-w-[920px] flex-col items-center px-6 text-center">
        <SectionEyebrow rule={false} className="mb-4">
          supported providers
        </SectionEyebrow>
        <h2
          id="providers-title"
          className="mb-4 text-[clamp(24px,3.2vw,32px)] leading-[1.12] font-semibold tracking-heading"
        >
          Verification built in for {PROVIDER_SLUGS.length} providers
        </h2>
        <p className="mb-8 max-w-[620px] text-md text-pretty text-fg-secondary">
          Point any of these at your endpoint and events arrive verified — HMAC, JWT, and asymmetric
          signatures, plus token and Basic-auth authenticity, all maintained for you. Don&rsquo;t
          see yours? Capture works for every sender; verification follows.
        </p>
        <ul className="flex flex-wrap justify-center gap-2.5">
          {PROVIDER_SLUGS.map((slug) => (
            <li
              key={slug}
              className={cn(
                "inline-flex items-center gap-2 rounded-pill border border-hairline px-3 py-1.5",
                "text-xs whitespace-nowrap text-fg-secondary",
              )}
            >
              {/* Static site: no /api/provider-icon route → monogram for logo-less brands (no 404s). */}
              <ProviderLogo slug={slug} size={16} faviconFallback={false} />
              {providerDisplayName(slug)}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
