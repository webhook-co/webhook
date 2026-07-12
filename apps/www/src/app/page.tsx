import { Faq } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { Hero } from "@/components/marketing/hero";
import { HOME_FAQ_ITEMS } from "@/components/marketing/home-faq";
import { PageShell } from "@/components/marketing/page-shell";
import { ProviderWall } from "@/components/marketing/provider-wall";
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
      {/* The 142 providers we can verify, named. The most credible thing the site owns, and it was
          invisible until now — the copy claimed the number while the page showed nothing. */}
      <Reveal>
        <ProviderWall />
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
