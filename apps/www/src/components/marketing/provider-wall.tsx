import { cn } from "@webhook-co/ui";

import { PROVIDER_ENTRIES } from "@/components/marketing/provider-entries";
import { ProviderMark } from "@/components/marketing/provider-mark";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { LINKS } from "@/lib/links";
import { container, sectionPad } from "@/lib/styles";

/**
 * The full inventory: every provider we can verify, named and marked. It lives on
 * /product/verification — the page whose whole subject this is — rather than on the homepage, where
 * 142 chips is a wall to scroll past rather than a fact to absorb. The homepage shows a recognisable
 * few ({@link ProviderStrip}) and sends you here.
 *
 * Marks resolve via {@link ProviderMark}: an official inline vector where one exists, else the brand's
 * favicon fetched at build time and served from our own origin. Nothing is requested from a third
 * party at render time.
 *
 * The list is generated from the adapter registry and pinned to it by `provider-wall.test.tsx`, so it
 * cannot drift from what the code can actually verify: add an adapter, the wall grows.
 */
export function ProviderWall() {
  return (
    <section aria-labelledby="providers" className={cn(container, sectionPad)}>
      <div className="mb-8 max-w-[62ch]">
        <SectionEyebrow className="mb-4">the registry</SectionEyebrow>
        {/* The homepage links straight here (/product/verification#providers), so this is a landing
            target, not just a heading. `scroll-mt-24` keeps the sticky header from parking on top of
            it — without it the browser scrolls the heading exactly under the nav bar. */}
        <h2
          id="providers"
          className="mb-4 scroll-mt-24 text-[clamp(26px,3.4vw,36px)] leading-tight font-semibold tracking-heading text-balance text-fg"
        >
          All {PROVIDER_ENTRIES.length} providers, built in
        </h2>
        <p className="text-md text-pretty text-fg-secondary">
          Each one is a signature scheme we implement and keep working &mdash; the header it signs,
          the bytes it signs over, and the quirks it insists on. The registry is open source, so you
          can read exactly how any of them is verified before you trust it. Full detail, including
          each provider&rsquo;s scheme and signature header, is in the{" "}
          <a
            href={LINKS.providerDirectory}
            className="rounded-control font-medium text-fg underline underline-offset-2 hover:text-fg-secondary"
          >
            provider directory
          </a>
          .
        </p>
      </div>

      {/* A plain list: crawlable, zero client JS, and it reads as what it is — an inventory. */}
      <ul className="flex flex-wrap gap-x-2 gap-y-2">
        {PROVIDER_ENTRIES.map((entry) => (
          <li
            key={entry.slug}
            className="inline-flex items-center gap-1.5 rounded-control border border-hairline bg-surface py-1 pr-2.5 pl-2 font-mono text-xs text-fg-secondary"
          >
            <ProviderMark entry={entry} />
            {entry.name}
          </li>
        ))}
      </ul>
    </section>
  );
}
