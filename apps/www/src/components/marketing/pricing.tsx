import { Button, cn } from "@webhook-co/ui";

import { container, focusRing, sectionPad } from "@/lib/styles";

import { OVERAGE_PER_MILLION, TIERS, type Tier } from "./pricing-tiers";

// The pricing page. Two rules govern the copy:
//
//   1. Say the real number. Never "affordable", never "generous", never "unlimited".
//   2. Disclose what surprises people BEFORE they pay — not in a footnote. Three things surprise people
//      here: a delivery is a billed event; a cancelled plan lands you paused (the free allowance is
//      one-time and already spent); and dedup=off makes every provider retry a new billable event. All
//      three are on this page, in the user's words. (ADR-0004 marks the churn one MUST-disclose.)

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

      {/* Baseline-aligned and nowrap: "From $499 /month" must never break across lines, and a long
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
      <p className="mt-6 text-center text-sm text-fg-secondary">
        Every plan includes outbound delivery, replay, deduplication, signature verification, the
        CLI, the API, and the MCP server. We don&apos;t gate features by plan.
      </p>
    </section>
  );
}

/** The three things that surprise people. Stated plainly, before they pay. */
export function PricingDisclosures() {
  return (
    <section aria-labelledby="what-counts" className={cn(container, sectionPad)}>
      <h2
        id="what-counts"
        className="mb-8 text-center text-[clamp(24px,3vw,34px)] leading-tight font-semibold tracking-heading text-fg"
      >
        What counts as an event
      </h2>

      <div className="mx-auto grid max-w-[900px] gap-6 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-fg">One capture, or one delivery</h3>
          <p className="text-sm leading-relaxed text-fg-secondary">
            A request we capture is one event. A delivery to a destination is one event. Forward a
            webhook to three destinations and that&apos;s four events — one capture, three
            deliveries. We meter delivery because it costs us real money, and we&apos;d rather
            charge for it honestly than lock it behind a paid tier.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-fg">Retries are never billed</h3>
          <p className="text-sm leading-relaxed text-fg-secondary">
            If a destination is down and we retry, you pay nothing extra. A delivery is billed once,
            when we first dispatch it, however many attempts it takes. Our retry schedule is our
            cost. Deduplicated duplicates, verification handshakes, and reading your own data are
            all free.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold text-fg">At your limit, capture pauses</h3>
          <p className="text-sm leading-relaxed text-fg-secondary">
            We email you before you reach your included volume, not after. At the limit, capture
            pauses rather than silently running up a bill. Turn on overage at {OVERAGE_PER_MILLION}{" "}
            per additional million events if you&apos;d rather keep going.
          </p>
        </div>
      </div>

      <div className="mx-auto mt-10 flex max-w-[900px] flex-col gap-4 rounded-card border border-hairline bg-surface p-6">
        <h3 className="text-base font-semibold text-fg">
          Two things worth knowing before you subscribe
        </h3>
        <p className="text-sm leading-relaxed text-fg-secondary">
          <strong className="text-fg">The free allowance is one-time.</strong> Those 5,000 events
          are counted across the whole life of your organisation and never reset. If you cancel a
          paid plan you return to the free tier with that allowance already spent, so{" "}
          <strong className="text-fg">capture pauses until you resubscribe</strong>. Your data stays
          exactly where it is, and resubscribing resumes capture immediately.
        </p>
        <p className="text-sm leading-relaxed text-fg-secondary">
          <strong className="text-fg">Deduplication is on by default.</strong>
          {/* An explicit string literal, not JSX text: a leading space directly after a closing tag is
              swallowed here (prettier normalises `{" "}` back to a plain space, which JSX then drops), and
              the sentence renders as "default.If you". Inside a string literal the space is verbatim. */}
          {
            " If you turn it off for an endpoint, every retry a provider sends is a distinct captured request, and each one counts. That’s the trade you’re making when you disable it."
          }
        </p>
      </div>
    </section>
  );
}
