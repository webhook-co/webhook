import { pageMetadata } from "../metadata";
import { AnnounceBar } from "@/components/marketing/announce-bar";
import { Faq } from "@/components/marketing/faq";
import { PricingDisclosure } from "@/components/marketing/pricing-disclosure";
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
        {/* The billing disclosure, in plain view. Neither of these is wrapped in <Reveal>: it paints
            its children at `opacity: 0` until an IntersectionObserver fires, and a disclosure the
            constitution requires to be "up front" cannot be gated behind a scroll animation — the
            measured effective opacity was literally 0. Prettiness does not get to sit in front of a
            billing promise.

            The FAQ used to BE this disclosure (its must-disclose entries were forced open). It now
            starts fully collapsed, like an accordion should, and the promise lives here instead —
            visible, unconditional, uncollapsible. */}
        <PricingDisclosure />
        <Faq />
        <Reveal>
          <FinalCta />
        </Reveal>
      </main>
      <Footer />
    </>
  );
}
