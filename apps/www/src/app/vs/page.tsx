import { cn } from "@webhook-co/ui";

import { pageMetadata } from "@/app/metadata";
import { PageShell } from "@/components/marketing/page-shell";
import { BreadcrumbJsonLd } from "@/components/marketing/structured-data";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { COMPARISONS, comparisonPath } from "@/lib/comparisons";
import { LINKS } from "@/lib/links";
import { container, focusRing, proseLink, sectionPad } from "@/lib/styles";

// The parent every /vs/<slug> page needs, and the only /vs page the site chrome links.
//
// This is the same lesson the tutorial estate paid for: sixteen pages shipped in the sitemap with
// ZERO inbound internal links, findable only by search. `check-orphan-pages.mjs` now fails a build
// for that, and the fix is not "add more links to the footer" — a footer listing every competitor
// would read as link-stuffing and would orphan the next one anyway. The fix is a hub that derives
// its index from COMPARISONS, so page five is linked the moment it exists.
//
// It carries a disqualification section on purpose. An estate of comparison pages with no reader it
// turns away is an advert, and everything else in the estate is believable only because this is here.
// It lives on the hub rather than as a fifth route so it cannot drift out of sync with the set.

export const metadata = pageMetadata({
  path: "/vs",
  title: "How webhook.co compares",
  description:
    "Honest, sourced comparisons against ngrok, webhook.site, Hookdeck and RequestBin — including where each of them is the better choice, and who should not use us.",
});

const h2 = "text-2xl font-semibold tracking-heading text-fg sm:text-[1.75rem]";
const body = "text-md text-pretty text-fg-secondary";
const prose = "mx-auto max-w-[62ch]";

export default function VsHubPage() {
  return (
    <PageShell
      after={
        <BreadcrumbJsonLd
          crumbs={[
            { name: "Home", path: "/" },
            { name: "Comparisons", path: "/vs" },
          ]}
        />
      }
    >
      <section className={container}>
        <div
          className={cn(prose, "pt-[clamp(40px,6vw,72px)] pb-[clamp(20px,3vw,32px)] text-center")}
        >
          <SectionEyebrow rule={false} className="mb-4 justify-center">
            compare
          </SectionEyebrow>
          <h1 className="mb-5 text-[clamp(30px,4.6vw,46px)] leading-[1.08] font-semibold tracking-display text-balance text-fg">
            How webhook.co compares
          </h1>
          <p className="mx-auto max-w-[54ch] text-lg text-pretty text-fg-secondary">
            Four comparisons, each written from the other product&apos;s own documentation and dated
            so you can tell how stale it is. Every one of them says where the other tool wins.
          </p>
        </div>
      </section>

      <section aria-labelledby="how-we-wrote-these" className={cn(container, sectionPad, "pt-0")}>
        <div className={prose}>
          <h2 id="how-we-wrote-these" className={cn(h2, "mb-4")}>
            How these were written
          </h2>
          <p className={cn(body, "mb-4")}>
            Every claim about another product was read off their own documentation and pricing pages
            on the date printed at the top of each comparison — not from memory, and not from
            someone else&apos;s comparison page. That mattered more than we expected: three of the
            things &quot;everyone knows&quot; about ngrok turned out to be years out of date, and we
            had to delete an entire argument we had planned to make.
          </p>
          <p className={cn(body, "mb-4")}>
            Where a competitor&apos;s own pages contradict each other, we say nothing rather than
            pick the number that flatters us. Where they are better, we say so in a section of its
            own rather than a footnote. And where we can&apos;t verify a claim about ourselves
            against shipped code in{" "}
            <a href={LINKS.openSource} className={proseLink}>
              our repository
            </a>
            , it doesn&apos;t go on the page.
          </p>
          <p className={body}>
            If something here is wrong — including if you work at one of these companies —{" "}
            <a href={LINKS.contact} className={proseLink}>
              tell us
            </a>{" "}
            and we&apos;ll fix it.
          </p>
        </div>
      </section>

      <section aria-labelledby="all-comparisons" className={cn(container, sectionPad, "pt-0")}>
        <div className={prose}>
          <h2 id="all-comparisons" className={cn(h2, "mb-4")}>
            All comparisons
          </h2>
        </div>
        {/* Derived from COMPARISONS, never hand-listed: a hand-listed index is precisely how the
            n+1th page ends up orphaned, and `page.test.tsx` asserts this set both ways. */}
        <nav aria-label="All comparisons" className={prose}>
          <ul className="flex flex-col gap-3">
            {COMPARISONS.map((c) => (
              <li key={c.slug}>
                <a
                  href={comparisonPath(c.slug)}
                  className={cn(
                    focusRing,
                    "flex flex-col gap-1 rounded-card border border-hairline bg-surface px-4 py-3.5 transition-colors hover:bg-surface-sunken",
                  )}
                >
                  <span className="font-semibold tracking-tight text-fg">
                    webhook.co vs {c.name}
                  </span>
                  <span className="text-sm text-pretty text-fg-muted">{c.lede}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </section>

      <section aria-labelledby="not-for-you" className={cn(container, sectionPad, "pt-0")}>
        <div className={prose}>
          <h2 id="not-for-you" className={cn(h2, "mb-4")}>
            When webhook.co is the wrong choice
          </h2>
          <p className={cn(body, "mb-4")}>
            We are pre-launch. If you are putting webhook infrastructure in front of production
            traffic this quarter and need a status page, contractual availability commitments and a
            completed security questionnaire, none of that is something we can offer you yet, and
            Hookdeck can. That is the honest answer and it costs us the sale.
          </p>
          <p className={cn(body, "mb-4")}>
            You also want a different tool if what you need is a general-purpose tunnel into a
            private network — that is ngrok, Cloudflare Tunnel or Tailscale, not us. If you need a
            URL in five seconds with no account at all, webhook.site is faster than anything we
            offer, though our{" "}
            <a href={LINKS.play} className={proseLink}>
              sandbox
            </a>{" "}
            is close. If you need to send webhooks to your own customers, with a portal they log
            into and manage their own endpoints in, that is a different product category and Svix is
            the established name in it. And if you want to rewrite payloads with arbitrary code
            before they reach you, both Hookdeck and webhook.site have real transformation engines
            and we have none.
          </p>
          <p className={body}>
            We do one thing: receive webhooks, verify them, keep them, and make them replayable from
            a CLI, an API, a dashboard and an MCP server. If that is not the shape of your problem,
            one of the tools above is a better answer than we are.
          </p>
        </div>
      </section>

      <section aria-labelledby="what-we-compare-on" className={cn(container, sectionPad, "pt-0")}>
        <div className={prose}>
          <h2 id="what-we-compare-on" className={cn(h2, "mb-4")}>
            What we compare on
          </h2>
          <p className={cn(body, "mb-4")}>
            Only things a stranger can check. Retention windows, what a free tier actually allows,
            which providers a tool verifies signatures for, what licence the code carries, and how
            many separate numbers go into a bill. We left out anything that would come down to
            taste, because a comparison row you cannot falsify is a row we picked because we would
            win it.
          </p>
          <p className={body}>
            Two rows you will not find anywhere in this estate: certifications and identity
            features. We hold neither, so any table containing them is a table we lose — and quietly
            omitting a row you would lose is the same trick as inventing one you would win.{" "}
            <a href={LINKS.securityPage} className={proseLink}>
              Our security page
            </a>{" "}
            says what we do and do not have.
          </p>
        </div>
      </section>
    </PageShell>
  );
}
