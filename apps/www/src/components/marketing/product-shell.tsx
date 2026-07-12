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
            <Button asChild size="md">
              <a href={LINKS.startFree}>Get started</a>
            </Button>
            <Button asChild variant="secondary" size="md">
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
 * One feature section on a product page: an h2 wired to `aria-labelledby`, then its prose. Prose is
 * capped at a readable measure by its own column rather than by squeezing the whole page — the page
 * keeps the homepage's full-width container, and the hero's visual lives on {@link ProductShell}.
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
    <section aria-labelledby={id} className={cn(container, sectionPad, "border-t border-hairline")}>
      <div className="max-w-[62ch]">
        <h2
          id={id}
          className="mb-4 text-2xl font-semibold tracking-heading text-balance text-fg sm:text-[28px]"
        >
          {heading}
        </h2>
        <div className="flex flex-col gap-4 text-md text-pretty text-fg-secondary">{children}</div>
      </div>
    </section>
  );
}
