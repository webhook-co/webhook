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
        {/* NOT wrapped in <Reveal>. The FAQ is now the pricing page's disclosure surface — it carries
            the MUST-disclose set (a delivery is billed, cancelling pauses you, dedup=off costs more),
            and `Reveal` paints its children at `opacity: 0` until an IntersectionObserver fires. A
            disclosure the constitution requires to be "up front" cannot be gated behind a scroll
            animation: measured effective opacity was literally 0. Prettiness does not get to sit in
            front of a billing promise. */}
        <Faq />
        <Reveal>
          <FinalCta />
        </Reveal>
      </main>
      <Footer />
    </>
  );
}
