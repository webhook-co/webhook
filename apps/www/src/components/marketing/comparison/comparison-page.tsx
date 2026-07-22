import { cn } from "@webhook-co/ui";

import { Faq } from "@/components/marketing/faq";
import { FinalCta } from "@/components/marketing/final-cta";
import { PageShell } from "@/components/marketing/page-shell";
import { BreadcrumbJsonLd } from "@/components/marketing/structured-data";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import type { Comparison } from "@/lib/comparisons";
import { comparisonPath, relatedComparisons } from "@/lib/comparisons";
import { LINKS } from "@/lib/links";
import { container, focusRing, proseLink, sectionPad } from "@/lib/styles";

/**
 * The shell every `/vs/<slug>` page renders through.
 *
 * It deliberately carries as little PROSE as possible. Everything a reader actually reads comes from
 * `lib/comparisons.ts`, per page, because shared sentence stock is exactly what drags a set of pages
 * towards being one page — and the near-duplicate check that would catch that is measured on the
 * authored fields, so boilerplate living here cannot mask a template living there.
 *
 * The section ORDER is the argument, and it is not arbitrary:
 *   1. who this page is for, and when it was last checked — a claim about another company that isn't
 *      dated is a claim we can't defend six months from now;
 *   2. the argument;
 *   3. the table, near the top, because that's what a mid-evaluation reader came for;
 *   4. the dimensions, which differ per competitor;
 *   5. WHAT THEY DO BETTER — a section of its own, not an aside. Everything above it is only
 *      believable because this exists;
 *   6. where we fit, migration, questions;
 *   7. sources, so every claim is one click from their own page saying it.
 */
const h2 = "text-2xl font-semibold tracking-heading text-fg sm:text-[1.75rem]";
const body = "text-md text-pretty text-fg-secondary";
const prose = "mx-auto max-w-[62ch]";

function Section({
  id,
  heading,
  children,
  className,
}: {
  id: string;
  heading: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cn(container, sectionPad, "pt-0", className)}>
      <div className={prose}>
        <h2 id={id} className={cn(h2, "mb-4")}>
          {heading}
        </h2>
        {children}
      </div>
    </section>
  );
}

export function ComparisonPage({ comparison: c }: { comparison: Comparison }) {
  const siblings = relatedComparisons(c.slug);
  return (
    <PageShell
      after={
        <BreadcrumbJsonLd
          crumbs={[
            { name: "Home", path: "/" },
            { name: "Comparisons", path: LINKS.comparisons },
            { name: c.h1, path: comparisonPath(c.slug) },
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
            {c.h1}
          </h1>
          <p className="mx-auto max-w-[54ch] text-lg text-pretty text-fg-secondary">{c.lede}</p>
          {/* Above the fold on purpose. A dated claim reads as dated; an undated one reads as current
              forever, which is the failure mode that turns a true page into a false one over time. */}
          <p className="mt-6 text-sm text-fg-muted">
            Claims about {c.name} verified against their own documentation on{" "}
            <time dateTime={c.verifiedOn}>{c.verifiedOn}</time>.{" "}
            <a href="#sources" className={proseLink}>
              Sources below
            </a>
            .
          </p>
          {/* The most decision-relevant fact about us, on EVERY page rather than on the one where it
              happened to get written. It lives in the shell, not in the per-page data, precisely so a
              fifth comparison cannot ship without it — `comparison-page.test.tsx` asserts it renders
              for every published comparison. It also carries the caveat the price and retention rows
              need: those figures are the published ladder, and billing is not live yet. */}
          <p className="mt-3 text-sm text-fg-muted">
            webhook.co is pre-launch. Our prices and retention windows below are published, not yet
            purchasable.
          </p>
        </div>
      </section>

      <Section id="why" heading="Why people compare these two">
        <p className={cn(body, "mb-4")}>{c.whyLeave}</p>
        <p className={body}>{c.distinctive}</p>
      </Section>

      <section aria-labelledby="at-a-glance" className={cn(container, sectionPad, "pt-0")}>
        <div className={prose}>
          <h2 id="at-a-glance" className={cn(h2, "mb-4")}>
            At a glance
          </h2>
        </div>
        {/* The table is the widest thing on the page, so it scrolls INSIDE this box rather than
            dragging the document sideways on a phone (playwright/mobile.spec.ts checks exactly that).
            A scroll container is a region a keyboard user must be able to reach and a screen reader
            must be able to name — hence tabindex and the label, without which axe is right to object. */}
        <div
          role="region"
          aria-label={`webhook.co and ${c.name} comparison table`}
          // A scrollable region MUST be keyboard-focusable, or a keyboard-only reader cannot scroll
          // it at all — which is exactly what axe's `scrollable-region-focusable` rule fails a build
          // for, and this page is axe-scanned in a real browser in both themes. The two gates
          // genuinely disagree and the accessibility one wins: dropping `tabIndex` to satisfy the
          // linter would convert a lint error into a reported WCAG failure. `role="region"` plus
          // `aria-label` is what makes the focus stop meaningful rather than a bare tab target.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- see above
          tabIndex={0}
          className={cn(prose, focusRing, "overflow-x-auto rounded-card border border-hairline")}
        >
          <table className="w-full border-collapse text-left text-sm">
            <caption className="sr-only">
              A row-by-row comparison of webhook.co and {c.name}, with sources.
            </caption>
            <thead>
              <tr className="border-b border-hairline">
                {/* Not blank: an empty column header is unreadable to a screen reader moving across
                    the header row, and axe flags it. Visually hidden so the corner still reads as
                    empty, which is what a sighted reader expects of a comparison table. */}
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  <span className="sr-only">Capability</span>
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  {c.name}
                </th>
                <th scope="col" className="px-4 py-3 font-semibold text-fg">
                  webhook.co
                </th>
              </tr>
            </thead>
            <tbody>
              {c.table.map((row) => (
                <tr key={row.label} className="border-b border-hairline last:border-b-0">
                  <th
                    scope="row"
                    className="px-4 py-3 align-top font-medium text-nowrap text-fg-secondary"
                  >
                    {row.label}
                  </th>
                  <td className="px-4 py-3 align-top text-fg-muted">{row.them}</td>
                  <td className="px-4 py-3 align-top text-fg-muted">{row.us}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {c.sections.map((section) => (
        <Section key={section.id} id={section.id} heading={section.heading}>
          <p className={body}>{section.body}</p>
        </Section>
      ))}

      {/* The concession, given the same visual weight as everything else rather than a footnote's. */}
      <Section id="choose-them" heading={c.chooseThem.heading}>
        <p className={body}>{c.chooseThem.body}</p>
      </Section>

      <Section id="choose-us" heading={c.chooseUs.heading}>
        <p className={body}>{c.chooseUs.body}</p>
      </Section>

      <Section id="migration" heading={`Moving from ${c.name}`}>
        <div className="flex flex-col gap-6">
          {c.migration.map((step) => (
            <div key={step.id}>
              <h3 className="mb-2 text-lg font-semibold tracking-tight text-fg">{step.heading}</h3>
              <p className={body}>{step.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Faq items={c.faq} heading={`Questions about ${c.name} and webhook.co`} />

      <section aria-labelledby="sources" className={cn(container, sectionPad, "pt-0")}>
        <div className={prose}>
          <h2 id="sources" className={cn(h2, "mb-4")}>
            Sources, and how to correct us
          </h2>
          <p className={cn(body, "mb-5")}>
            Every claim above about {c.name} was read off the pages below on the date shown, not
            from memory. Products change faster than pages do — if something here is wrong or out of
            date, including if you work at {c.name},{" "}
            <a href={LINKS.contact} className={proseLink}>
              tell us
            </a>{" "}
            and we&apos;ll fix it.
          </p>
          <ul className="flex flex-col gap-2.5">
            {c.sources.map((source) => (
              <li key={source.id} className="text-sm text-fg-muted">
                {/* Underlined, not merely coloured. Each of these sits inline with the "— checked
                    <date>" text beside it, which makes it a link in a text block: colour alone is not
                    a distinguishing feature, and axe's `link-in-text-block` rule fails the real-browser
                    scan for it. The jsdom suite cannot see this — it has no cascade to measure. */}
                <a
                  href={source.url}
                  rel="nofollow noopener"
                  className={cn(
                    focusRing,
                    "rounded-control underline decoration-strong underline-offset-2 text-fg-secondary transition-colors hover:text-fg hover:decoration-fg",
                  )}
                >
                  {source.label}
                </a>
                {/* `text-fg-faint` is a DECORATIVE token — it measures 2.45:1 against the light-mode
                    page and fails WCAG AA for text, which the real-browser axe scan caught and no
                    jsdom assertion ever could. The check date is information, so it gets the body
                    token. */}
                <span className="text-fg-muted">
                  {" "}
                  — checked <time dateTime={source.checked}>{source.checked}</time>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="more-comparisons" className={cn(container, sectionPad, "pt-0")}>
        <div className={prose}>
          <h2 id="more-comparisons" className={cn(h2, "mb-4")}>
            Other comparisons
          </h2>
          <ul className="flex flex-wrap gap-3">
            {siblings.map((sibling) => (
              <li key={sibling.slug}>
                <a
                  href={comparisonPath(sibling.slug)}
                  className={cn(
                    focusRing,
                    "inline-flex rounded-card border border-hairline bg-surface px-3.5 py-2.5 text-sm text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
                  )}
                >
                  webhook.co vs {sibling.name}
                </a>
              </li>
            ))}
            <li>
              <a
                href={LINKS.comparisons}
                className={cn(
                  focusRing,
                  "inline-flex rounded-card border border-hairline bg-surface px-3.5 py-2.5 text-sm text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
                )}
              >
                All comparisons
              </a>
            </li>
          </ul>
        </div>
      </section>

      <FinalCta />
    </PageShell>
  );
}
