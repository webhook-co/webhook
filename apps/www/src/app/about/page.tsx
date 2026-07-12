import { cn } from "@webhook-co/ui";

import { pageMetadata } from "@/app/metadata";
import { FinalCta } from "@/components/marketing/final-cta";
import { PageShell } from "@/components/marketing/page-shell";
import { BreadcrumbJsonLd } from "@/components/marketing/structured-data";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { container, sectionPad } from "@/lib/styles";

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
const sectionH2 = "text-2xl font-semibold tracking-heading text-fg sm:text-[1.75rem]";

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
    <PageShell
      after={
        <BreadcrumbJsonLd
          crumbs={[
            { name: "Home", path: "/" },
            { name: "About", path: "/about" },
          ]}
        />
      }
    >
      {/* The hero uses the homepage's grammar — the full 1120px container and a two-column grid —
          rather than capping the whole page at 62ch, which read as a narrow column adrift in a wide
          canvas. Line length is still controlled, but per-element, the way the homepage does it. */}
      <div className={cn(container, sectionPad)}>
        <div className="mb-4 grid items-center gap-x-12 gap-y-8 min-[820px]:grid-cols-[minmax(0,1fr)_minmax(0,260px)]">
          <div>
            <SectionEyebrow rule={false} className="mb-4">
              about
            </SectionEyebrow>
            <h1 className="mb-6 max-w-[18ch] text-[clamp(30px,4.6vw,48px)] leading-[1.08] font-semibold tracking-display text-balance text-fg">
              webhook.co is built by one person, on purpose
            </h1>
            <p className="max-w-[56ch] text-lg text-pretty text-fg-secondary">
              I&rsquo;m Sourabh Choraria, and I&rsquo;m building webhook.co on my own, from Porto,
              Portugal. It&rsquo;s an inbound webhook gateway: it captures the events other services
              send you, verifies them, keeps them in order, and never drops one silently.
            </p>
          </div>
          {/* Self-hosted (never hotlinked), resized and EXIF-stripped — the original carried camera
              and timestamp metadata. Explicit dimensions so it reserves its box and can't shift the
              layout (the Lighthouse gate holds CLS ≤ 0.1). It's also the Person node's image. */}
          <img
            src="/sourabh-choraria.webp"
            alt="Sourabh Choraria, the founder of webhook.co"
            width={480}
            height={480}
            loading="eager"
            className="mx-auto w-full max-w-[220px] rounded-card border border-hairline min-[820px]:max-w-[260px]"
          />
        </div>

        {/* CENTRED, not left-aligned. The hero is a two-column grid (prose + photo); leaving the prose
            below it hard against the left edge made the photo's column read as an empty right-hand
            sidebar running the length of the page. Centring makes the whitespace symmetric and the
            column deliberate — an essay, which is what this is. The principles grid below breaks out
            to the full container so the page still uses its width. */}
        <article className="mx-auto max-w-[68ch]">
          {/* Why this exists */}
          <section aria-labelledby="why" className="mt-14">
            <h2 id="why" className={cn("mb-4", sectionH2)}>
              Why it exists
            </h2>
            <p className="mb-4 text-md text-pretty text-fg-secondary">
              Every developer who has integrated a webhook knows the same afternoon: a signature
              that won&rsquo;t verify and won&rsquo;t say why, an event that arrived but never made
              it into the database, a provider that quietly disabled your endpoint after one too
              many 5xxs. Every new provider you add is a new way to fail silently.
            </p>
            <p className="text-md text-pretty text-fg-secondary">
              webhook.co exists to make that boring. One place to capture the webhooks you receive,
              verify them against 142 providers, and replay them &mdash; with the failure reason
              named in plain language instead of a generic mismatch. It&rsquo;s the tool I wanted
              the last several times a webhook broke in production.
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
              you what&rsquo;s shipped than what&rsquo;s coming &mdash; so nothing goes on this site
              until it&rsquo;s true, and the roadmap lives in the changelog, not the marketing.
            </p>
          </section>
        </article>

        {/* OUTSIDE the prose article, so it spans the full 1120px container: four cards across on a
            wide screen. This is what stops the centred essay above from reading as a thin ribbon on a
            big canvas — the page narrows to read, then opens back up. */}
        <section aria-labelledby="principles" className="mt-16">
          <h2 id="principles" className={cn("mb-6", sectionH2)}>
            What it&rsquo;s built around
          </h2>
          <dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="rounded-card border border-hairline bg-surface p-5">
                <dt className="mb-1.5 font-semibold tracking-tight text-fg">{p.title}</dt>
                <dd className="text-sm text-pretty text-fg-secondary">{p.body}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>

      <FinalCta />
    </PageShell>
  );
}
