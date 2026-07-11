import { cn } from "@webhook-co/ui";

import { pageMetadata } from "@/app/metadata";
import { AnnounceBar } from "@/components/marketing/announce-bar";
import { FinalCta } from "@/components/marketing/final-cta";
import { Footer } from "@/components/marketing/footer";
import { Nav } from "@/components/marketing/nav";
import { BreadcrumbJsonLd } from "@/components/marketing/structured-data";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { container, sectionPad } from "@/lib/styles";
import { SkipLink } from "@/components/marketing/skip-link";

// pageMetadata sets this page's own canonical + og:url. The /about page is also the canonical URL of
// the founder Person node in the site's JSON-LD (see structured-data.ts), so it's the human-readable
// half of the entity-resolution work: the anchor that tells search engines webhook.co is a specific
// company, built by a specific person — not the generic noun it's currently confused with.
export const metadata = pageMetadata({
  path: "/about",
  title: "About",
  description:
    "webhook.co is an inbound webhook gateway built by one person — Sourabh Choraria, in Porto, Portugal. What it is, and why it's built this way.",
});

// One heading treatment for the section h2s, so they can't drift out of sync (only the bottom
// margin varies per section).
const sectionH2 = "text-2xl font-semibold tracking-heading text-fg sm:text-[28px]";

const PRINCIPLES = [
  {
    title: "Precise over persuasive",
    body: "Real numbers, real mechanisms. The site says what the code does today — not what's on a roadmap.",
  },
  {
    title: "Private by default",
    body: "Nothing you capture is listed, shared, or public unless you explicitly make it so.",
  },
  {
    title: "One number to reason about",
    body: "Billing is a single dimension — events. No per-step meters, no surprise invoice at the ceiling.",
  },
  {
    title: "Open at the core",
    body: "The engine, CLI, MCP server, and signing library are open source under Apache-2.0. You can read exactly how it verifies a signature.",
  },
];

export default function AboutPage() {
  return (
    <>
      <SkipLink />
      <header>
        <AnnounceBar />
        <Nav />
      </header>

      <main id="main">
        <div className={cn(container, sectionPad)}>
          <article className="mx-auto max-w-[62ch]">
            {/* Hero */}
            <SectionEyebrow rule={false} className="mb-4">
              about
            </SectionEyebrow>
            <h1 className="mb-6 text-[clamp(30px,4.6vw,48px)] leading-[1.08] font-semibold tracking-display text-balance text-fg">
              webhook.co is built by one person, on purpose
            </h1>
            <p className="mb-6 text-lg text-pretty text-fg-secondary">
              I&rsquo;m Sourabh Choraria, and I&rsquo;m building webhook.co on my own, from Porto,
              Portugal. It&rsquo;s an inbound webhook gateway: it captures the events other services
              send you, verifies them, keeps them in order, and never drops one silently.
            </p>

            {/* Why this exists */}
            <section aria-labelledby="why" className="mt-14">
              <h2 id="why" className={cn("mb-4", sectionH2)}>
                Why it exists
              </h2>
              <p className="mb-4 text-md text-pretty text-fg-secondary">
                Every developer who has integrated a webhook knows the same afternoon: a signature
                that won&rsquo;t verify and won&rsquo;t say why, an event that arrived but never
                made it into the database, a provider that quietly disabled your endpoint after one
                too many 5xxs. Every new provider you add is a new way to fail silently.
              </p>
              <p className="text-md text-pretty text-fg-secondary">
                webhook.co exists to make that boring. One place to capture the webhooks you
                receive, verify them against 142 providers, and replay them &mdash; with the failure
                reason named in plain language instead of a generic mismatch. It&rsquo;s the tool I
                wanted the last several times a webhook broke in production.
              </p>
            </section>

            {/* Why solo */}
            <section aria-labelledby="solo" className="mt-14">
              <h2 id="solo" className={cn("mb-4", sectionH2)}>
                Why one person
              </h2>
              <p className="mb-4 text-md text-pretty text-fg-secondary">
                Small is deliberate, not a stopgap. One person who has run webhooks in production
                makes different calls than a roadmap does: a free tier that&rsquo;s an honest trial
                rather than a bait-and-switch, pricing you can hold in your head, defaults that
                protect you before they upsell you, and an open core you can actually read.
              </p>
              <p className="text-md text-pretty text-fg-secondary">
                It also sets an honest expectation. webhook.co is pre-launch. I&rsquo;d rather tell
                you what&rsquo;s shipped than what&rsquo;s coming &mdash; so nothing goes on this
                site until it&rsquo;s true, and the roadmap lives in the changelog, not the
                marketing.
              </p>
            </section>

            {/* Principles */}
            <section aria-labelledby="principles" className="mt-14">
              <h2 id="principles" className={cn("mb-6", sectionH2)}>
                What it&rsquo;s built around
              </h2>
              <dl className="grid gap-6 sm:grid-cols-2">
                {PRINCIPLES.map((p) => (
                  <div key={p.title} className="rounded-card border border-hairline bg-surface p-5">
                    <dt className="mb-1.5 font-semibold tracking-tight text-fg">{p.title}</dt>
                    <dd className="text-sm text-pretty text-fg-secondary">{p.body}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </article>
        </div>

        <FinalCta />
      </main>

      <Footer />
      <BreadcrumbJsonLd
        crumbs={[
          { name: "Home", path: "/" },
          { name: "About", path: "/about" },
        ]}
      />
    </>
  );
}
