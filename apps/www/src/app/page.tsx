import { AnnounceBar } from "@/components/marketing/announce-bar";
import { FinalCta } from "@/components/marketing/final-cta";
import { Footer } from "@/components/marketing/footer";
import { Hero } from "@/components/marketing/hero";
import { Nav } from "@/components/marketing/nav";
import { Reveal } from "@/components/marketing/reveal";
import { Showcases } from "@/components/marketing/showcases";
import { SurfacesTabs } from "@/components/marketing/surfaces/surfaces-tabs";
import { TrustBand } from "@/components/marketing/trust-band";
import { SkipLink } from "@/components/marketing/skip-link";

export default function HomePage() {
  return (
    <>
      <SkipLink />
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
