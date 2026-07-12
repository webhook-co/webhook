import type { ReactNode } from "react";

import { Button, cn } from "@webhook-co/ui";

import { FinalCta } from "@/components/marketing/final-cta";
import { PageShell } from "@/components/marketing/page-shell";
import { BreadcrumbJsonLd } from "@/components/marketing/structured-data";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { LINKS } from "@/lib/links";
import { container, sectionPad } from "@/lib/styles";

/**
 * The shared shell for every /product/* page: the site chrome (via {@link PageShell}) → a consistent
 * hero (eyebrow, h1, lede, one primary CTA + a "read the docs" deep link) → the page's own feature
 * sections → the final CTA. Only the copy varies, so the five product pages can't drift in structure,
 * heading scale, or CTA treatment. It also emits the page's Home › Name breadcrumb from `path`+`name`,
 * so each page declares its slug once (no copy-pasted crumb arrays to drift). Pages compose feature
 * sections with {@link ProductFeature}.
 */
export function ProductShell({
  eyebrow,
  title,
  lede,
  path,
  name,
  docsHref,
  docsLabel = "Read the docs",
  showStartCta = true,
  visual,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: ReactNode;
  /** This page's route, e.g. "/product/verification" — used for the breadcrumb (and given once). */
  path: string;
  /** Short breadcrumb label, e.g. "Verification". */
  name: string;
  /** The docs page this capability documents — the one place a product page links to docs.webhook.co. */
  docsHref: string;
  docsLabel?: string;
  /**
   * Whether the hero leads with the sign-up CTA. True for the /product pages — they're selling a
   * capability. False for /security, which is a TRUST page: someone reading it is asking "can I
   * rely on this", and answering with "Start free" is answering a question they didn't ask.
   */
  showStartCta?: boolean;
  /** The hero's right column — a live/animated widget, mirroring the homepage hero's Inspector. */
  visual?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageShell
      after={
        <BreadcrumbJsonLd
          crumbs={[
            { name: "Home", path: "/" },
            { name, path },
          ]}
        />
      }
    >
      {/* Same grammar as the homepage hero: the full 1120px container, a two-column grid, and line
          length controlled per-ELEMENT (h1/lede) rather than by capping the whole page at 46ch — which
          is what made these pages read as a narrow column floating in a wide, empty canvas. */}
      <section
        className={cn(
          container,
          "grid items-center gap-x-12 gap-y-10 pt-[clamp(40px,6vw,72px)] pb-[clamp(28px,4vw,44px)]",
          visual && "min-[940px]:grid-cols-[minmax(0,1fr)_minmax(0,520px)]",
        )}
      >
        <div>
          <SectionEyebrow rule={false} className="mb-4">
            {eyebrow}
          </SectionEyebrow>
          <h1 className="mb-6 max-w-[20ch] text-[clamp(32px,5vw,52px)] leading-[1.06] font-semibold tracking-display text-balance text-fg">
            {title}
          </h1>
          <p className="mb-8 max-w-[54ch] text-lg text-pretty text-fg-secondary">{lede}</p>
          <div className="flex flex-wrap gap-3">
            {showStartCta ? (
              <Button asChild size="md">
                <a href={LINKS.startFree}>Get started</a>
              </Button>
            ) : null}
            <Button asChild variant={showStartCta ? "secondary" : "primary"} size="md">
              <a href={docsHref}>{docsLabel}</a>
            </Button>
          </div>
        </div>
        {visual ? <div className="mx-auto w-full max-w-[520px]">{visual}</div> : null}
      </section>

      {children}

      <FinalCta />
    </PageShell>
  );
}

/**
 * The features of a product page, as ONE row of cards rather than a stack of full-width rows — three
 * long prose bands down a wide page made every product page read the same and scroll forever.
 *
 * The grid WRAPS rather than hardcoding three across: the pages carry 3, 4 (verification) and 6
 * (/security) features, so a fixed `grid-cols-3` would strand the extras. Three-up on a wide
 * screen, two-up on a tablet, one-up on a phone.
 *
 * `items-start` matters: without it the grid stretches every card to the tallest one's height, which
 * looks fine at 3 equal cards and ragged the moment one has a longer paragraph.
 */
export function ProductFeatures({ children }: { children: ReactNode }) {
  return (
    <section className={cn(container, sectionPad, "border-t border-hairline")}>
      <div className="grid items-start gap-5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

/**
 * One feature, as a card. Still an h2 wired to `aria-labelledby` on its own landmark — turning these
 * into cards is a LAYOUT change, so the heading outline and the a11y semantics stay exactly as they
 * were. Must be rendered inside {@link ProductFeatures}.
 */
export function ProductFeature({
  id,
  heading,
  children,
}: {
  id: string;
  heading: string;
  children: ReactNode;
}) {
  return (
    <article
      aria-labelledby={id}
      className="h-full rounded-card border border-hairline bg-surface p-5 sm:p-6"
    >
      <h2
        id={id}
        className="mb-3 text-lg font-semibold tracking-heading text-balance text-fg sm:text-xl"
      >
        {heading}
      </h2>
      <div className="flex flex-col gap-3 text-sm text-pretty text-fg-secondary">{children}</div>
    </article>
  );
}
