import { cn } from "@webhook-co/ui";

import { AnnounceBar } from "@/components/marketing/announce-bar";
import { FinalCta } from "@/components/marketing/final-cta";
import { Footer } from "@/components/marketing/footer";
import { Hero } from "@/components/marketing/hero";
import { Nav } from "@/components/marketing/nav";
import { Reveal } from "@/components/marketing/reveal";
import { Showcases } from "@/components/marketing/showcases";
import { SurfacesTabs } from "@/components/marketing/surfaces/surfaces-tabs";
import { TrustBand } from "@/components/marketing/trust-band";
import { focusRing } from "@/lib/styles";

export default function HomePage() {
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
        <Hero />
        <SurfacesTabs />
        <Reveal>
          <Showcases />
        </Reveal>
        <Reveal>
          <TrustBand />
        </Reveal>
        <Reveal>
          <FinalCta />
        </Reveal>
      </main>
      <Footer />
    </>
  );
}
