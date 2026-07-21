import { cn } from "@webhook-co/ui";

import { PROVIDER_ENTRIES } from "@/components/marketing/provider-entries";
import { ProviderMark } from "@/components/marketing/provider-mark";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { LINKS } from "@/lib/links";
import { container, focusRing, sectionPad } from "@/lib/styles";

/**
 * The homepage's provider proof: a recognisable HANDFUL, then a way through to all 141.
 *
 * The full 141-chip wall used to live here. It didn't earn the space: at that length it stops being
 * a fact you absorb and becomes a wall you scroll past — and it cost the homepage ~57KB gzipped of
 * inline path data. The complete inventory now lives on /product/verification, which is the page
 * actually about verification; the homepage makes the claim and points at the evidence.
 *
 * FEATURED is a curated subset, not a ranking — the names a developer is most likely to recognise, so
 * the claim lands without 141 chips. Every slug is checked against the real registry by
 * `provider-strip.test.tsx`: we never show a provider we cannot actually verify.
 */
const FEATURED = [
  "stripe",
  "github",
  "shopify",
  "slack",
  "twilio",
  "hubspot",
  "sendgrid",
  "linear",
  "openai",
  "square",
  "notion",
  "vercel",
  "discord",
  "intercom",
  "docusign",
  "dropbox",
  "zoom",
  "plaid",
] as const;

const FEATURED_ENTRIES = FEATURED.map((slug) =>
  PROVIDER_ENTRIES.find((p) => p.slug === slug)!,
).filter(Boolean);

export function ProviderStrip() {
  return (
    <section aria-labelledby="providers" className={cn(container, sectionPad)}>
      <div className="mb-7 max-w-[60ch]">
        <SectionEyebrow className="mb-4">verification</SectionEyebrow>
        <h2
          id="providers"
          className="mb-4 text-[clamp(26px,3.4vw,36px)] leading-tight font-semibold tracking-heading text-balance text-fg"
        >
          {PROVIDER_ENTRIES.length} providers, verified on arrival
        </h2>
        <p className="text-md text-pretty text-fg-secondary">
          Point any of them at a webhook.co endpoint and the signature is checked before the event
          reaches you &mdash; you don&rsquo;t write the verification code, and you don&rsquo;t keep
          the signing secret in your app. When a check fails, you get the reason, not a boolean.
        </p>
      </div>

      <ul className="mb-6 flex flex-wrap gap-x-2 gap-y-2">
        {FEATURED_ENTRIES.map((entry) => (
          <li
            key={entry.slug}
            className="inline-flex items-center gap-1.5 rounded-control border border-hairline bg-surface py-1 pr-2.5 pl-2 font-mono text-xs text-fg-secondary"
          >
            <ProviderMark entry={entry} />
            {entry.name}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {/* Lands on the registry itself, not the top of the page — the same deep-link-to-a-section
            behaviour the legal pages have. `#providers` is the wall's own heading id, and
            check-anchors.mjs verifies against the BUILT html that this fragment still resolves, so
            the link can't quietly rot into a scroll-to-nowhere. */}
        <a
          href={`${LINKS.product.verification}#providers`}
          className={cn(
            "rounded-control font-medium text-fg underline underline-offset-2 hover:text-fg-secondary",
            focusRing,
          )}
        >
          {/* One string, not text-and-expression: JSX dropped the space around the interpolated count
              and it shipped as "See all 142providers". */}
          {`See all ${PROVIDER_ENTRIES.length} providers`} <span aria-hidden="true">&rarr;</span>
        </a>
        <a
          href={LINKS.providerDirectory}
          className={cn(
            "rounded-control text-fg-secondary underline underline-offset-2 hover:text-fg",
            focusRing,
          )}
        >
          Schemes and signature headers, provider by provider
        </a>
      </div>
    </section>
  );
}
