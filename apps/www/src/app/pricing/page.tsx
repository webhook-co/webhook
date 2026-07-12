import { pageMetadata } from "../metadata";
import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Faq } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { PricingHero, PricingTable } from "@/components/marketing/pricing";
import { Reveal } from "@/components/marketing/reveal";
import { SkipLink } from "@/components/marketing/skip-link";

// pageMetadata sets this page's own canonical + og:url (the root's canonical:"/" is otherwise
// inherited, canonicalising /pricing to the homepage). Title template appends " — webhook.co".
export const metadata = pageMetadata({
  path: "/pricing",
  title: "Pricing",
  description:
    "One number to watch: events. Every feature is on every plan. At your limit we pause, we don't bill.",
});

export default function PricingPage() {
  return (
    <>
      <SkipLink />
      <header>
        <AnnounceBar />
        <Nav />
      </header>
      <main id="main">
        <PricingHero />
        <PricingTable />
        {/* NOT wrapped in <Reveal>: it paints its children at `opacity: 0` until an IntersectionObserver
            fires, and the first panel carries the BILLABLE UNIT, which AGENTS.md requires be disclosed
            "up front". A disclosure gated behind a scroll animation is not up front — the measured
            effective opacity was literally 0. `openFirst` is what keeps it readable without a click. */}
        <Faq openFirst />
        <Reveal>
          <FinalCta />
        </Reveal>
      </main>
      <Footer />
    </>
  );
}
