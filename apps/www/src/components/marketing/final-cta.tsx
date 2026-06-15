import { Button, cn } from "@webhook-co/ui";

import { container, focusRing, sectionPad } from "@/lib/styles";

const metaLinkClass =
  "rounded-control border-b border-strong text-fg-secondary transition-colors hover:border-fg hover:text-fg";

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className={cn(container, sectionPad, "text-center")}>
      <h2
        id="cta-title"
        className="mx-auto mb-5 max-w-[18ch] text-[clamp(30px,4.6vw,50px)] leading-[1.05] font-semibold tracking-display text-fg"
      >
        Point a webhook at it. Watch it land.
      </h2>
      <p className="mx-auto mb-8 max-w-[54ch] text-lg text-pretty text-fg-secondary">
        Start on the Free tier: a permanent URL, full inspection, and one-command replay. Move up
        when your team needs ingestion, delivery, or controls.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild size="md">
          <a href="#">Start free</a>
        </Button>
        <Button asChild variant="secondary" size="md">
          <a href="#">Read the docs</a>
        </Button>
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3 font-mono text-xs text-fg-muted">
        <a href="#" className={cn(focusRing, metaLinkClass)}>
          Star us on GitHub
        </a>
        <span aria-hidden="true">·</span>
        <span>Apache-2.0</span>
        <span aria-hidden="true">·</span>
        <a href="#" className={cn(focusRing, metaLinkClass)}>
          Status
        </a>
      </div>
    </section>
  );
}
