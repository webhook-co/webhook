import { Button, cn } from "@webhook-co/ui";

import { container, focusRing } from "@/lib/styles";

import { TIERS, type Tier } from "./pricing-tiers";

// The pricing page. Two rules govern the copy:
//
//   1. Say the real number. Never "affordable", never "generous", never "unlimited".
//   2. Disclose what surprises people BEFORE they pay — not in a footnote. Three things surprise people
//      here: a delivery is a billed event; a cancelled plan lands you paused (the free allowance is
//      one-time and already spent); and dedup=off makes every provider retry a new billable event.
//      Those three now live in the FAQ below, rendered `<details open>` so they are visible without a
//      click — collapsed, they would BE the footnote this rule forbids. `faq.tsx` carries the
//      MUST-DISCLOSE flag and `faq.test.tsx` pins it. (ADR-0004 marks the churn one MUST-disclose.)

export function PricingHero() {
  return (
    <section className={cn(container, "pt-[clamp(40px,5vw,72px)] pb-2 text-center")}>
      <h1 className="mx-auto mb-5 max-w-[20ch] text-[clamp(32px,5vw,54px)] leading-[1.05] font-semibold tracking-display text-fg">
        Pricing that can&apos;t surprise you
      </h1>
      <p className="mx-auto max-w-[58ch] text-lg text-pretty text-fg-secondary">
        One number to watch: events. Every feature is on every plan — including outbound delivery.
        Plans differ only by how many events they include. At your limit we pause, we don&apos;t
        bill.
      </p>
    </section>
  );
}

function TierCard({ tier }: { tier: Tier }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-5 rounded-card border bg-surface p-6",
        tier.featured ? "border-fg" : "border-hairline",
      )}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-heading text-fg">{tier.name}</h2>
          {tier.featured && (
            <span className="rounded-full border border-hairline px-2 py-0.5 text-xs text-fg-secondary">
              Most teams
            </span>
          )}
        </div>
        <p className="text-sm leading-snug text-fg-secondary">{tier.summary}</p>
      </div>

      {/* Baseline-aligned and nowrap: "From €499 /month" must never break across lines, and a long
          qualifier must not push the cadence onto its own row. */}
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        {tier.pricePrefix && <span className="text-sm text-fg-secondary">{tier.pricePrefix}</span>}
        <span className="text-3xl font-semibold tracking-heading text-fg">
          {tier.price ?? "Free"}
        </span>
        {tier.cadence && <span className="text-sm text-fg-secondary">{tier.cadence}</span>}
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex flex-col">
          <dt className="sr-only">Included events</dt>
          <dd className="text-fg">{tier.includedEvents}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="sr-only">Overage</dt>
          <dd className="text-fg-secondary">{tier.overage}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="sr-only">Retention</dt>
          <dd className="text-fg-secondary">{tier.retention}</dd>
        </div>
      </dl>

      <Button
        asChild
        variant={tier.featured ? "primary" : "secondary"}
        size="md"
        className="mt-auto"
      >
        <a className={focusRing} href={tier.cta.href}>
          {tier.cta.label}
        </a>
      </Button>
    </div>
  );
}

export function PricingTable() {
  return (
    <section aria-label="Plans" className={cn(container, "pt-8 pb-4")}>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {TIERS.map((tier) => (
          <TierCard key={tier.id} tier={tier} />
        ))}
      </div>
      <p className="mt-6 text-center text-fg-secondary">
        Every plan includes outbound delivery, replay, deduplication, signature verification, the
        CLI, the API, and the MCP server. We don&apos;t gate features by plan.
      </p>
    </section>
  );
}
