import { Button, cn, PlanCard } from "@webhook-co/ui";

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
    <PlanCard
      plan={tier}
      cta={
        <Button
          asChild
          variant={tier.featured ? "primary" : "secondary"}
          size="md"
          className="w-full"
        >
          <a className={focusRing} href={tier.cta.href}>
            {tier.cta.label}
          </a>
        </Button>
      }
    />
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
