import { FinalCta } from "@/components/marketing/final-cta";
import { Hero } from "@/components/marketing/hero";
import { PageShell } from "@/components/marketing/page-shell";
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
      <Reveal>
        <TrustBand />
      </Reveal>
      <Reveal>
        <FinalCta />
      </Reveal>
    </PageShell>
  );
}
