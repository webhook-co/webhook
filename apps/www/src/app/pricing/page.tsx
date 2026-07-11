import { cn } from "@webhook-co/ui";
import type { Metadata } from "next";

import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Faq } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { PricingHero, PricingTable } from "@/components/marketing/pricing";
import { Reveal } from "@/components/marketing/reveal";
import { focusRing } from "@/lib/styles";

export const metadata: Metadata = {
  // The root layout's title template already appends " — webhook.co"; don't say it twice.
  title: "Pricing",
  description:
    "One number to watch: events. Every feature is on every plan. At your limit we pause, we don't bill.",
};

export default function PricingPage() {
  return (
    <>
      <a
        href="#main"
        className={cn(
          focusRing,
          "sr-only rounded-control bg-surface px-4 py-2 text-sm text-fg shadow-2 focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-[100]",
        )}
      >
        Skip to content
      </a>
      <header>
        <AnnounceBar />
        <Nav />
      </header>
      <main id="main">
        <PricingHero />
        <PricingTable />
        <Reveal>
          <Faq />
        </Reveal>
        <Reveal>
          <FinalCta />
        </Reveal>
      </main>
      <Footer />
    </>
  );
}
