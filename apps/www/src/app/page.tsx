import { Faq } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { Hero } from "@/components/marketing/hero";
import { HOME_FAQ_ITEMS } from "@/components/marketing/home-faq";
import { PageShell } from "@/components/marketing/page-shell";
import { ProviderStrip } from "@/components/marketing/provider-strip";
import { Reveal } from "@/components/marketing/reveal";
import { Showcases } from "@/components/marketing/showcases";
import { SurfacesTabs } from "@/components/marketing/surfaces/surfaces-tabs";
import { TrustBand } from "@/components/marketing/trust-band";

export default function HomePage() {
  return (
    <PageShell>
      <Hero />
      <SurfacesTabs />
      <Reveal>
        <Showcases />
      </Reveal>
      {/* A recognisable handful of the 142 we verify, then a way through to the full registry on
          /product/verification. The whole wall here was a thing to scroll past, not a fact to absorb. */}
      <Reveal>
        <ProviderStrip />
      </Reveal>
      <Reveal>
        <TrustBand />
      </Reveal>
      {/* The homepage FAQ answers the ENTITY questions (what this is, what it isn't, who builds it) —
          a different set from the pricing FAQ, so the two FAQPage schemas don't duplicate. It's also
          the surface an answer engine can actually quote, which is the whole point. */}
      <Reveal>
        <Faq items={HOME_FAQ_ITEMS} heading="Questions people actually ask" />
      </Reveal>
      <Reveal>
        <FinalCta />
      </Reveal>
    </PageShell>
  );
}
