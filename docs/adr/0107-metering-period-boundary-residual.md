# ADR 0107 — metering: the period-boundary day is an accepted bounded residual

- status: accepted.
- date: 2026-07-10
- scope: metering/billing (`packages/db/tail-flush.ts`, `packages/db/meter-reporter.ts`,
  `apps/api/stripe-webhook.ts`). No code change — this ADR records a deliberate non-decision (F4 declined).
- relates: [0020](0020-billing-metering-architecture.md) (metering architecture),
  [0004](0004-hybrid-flat-alert-first-pricing.md) (pricing / Definition-B metering).

## context

A billed event is one inbound capture OR one outbound delivery dispatch (Definition B, ADR-0004). Usage is
derived from the exactly-once `events` / `delivery_attempts` rows and rolled up **per UTC day**; a day is
frozen (`usage.finalized_at`) only after a settle window (`USAGE_SETTLE_DAYS = 2`) so late-committed events
are never lost.

That settle window collided with a Stripe fact we proved empirically (a sandbox test-clock probe): **a meter
event whose `timestamp` falls in a billing period whose invoice has already finalized is silently DROPPED**
(not rolled forward, not credited). Because every day we report is ≥2 days old, the last ~2 days of each
period reached Stripe after that period's invoice finalized (~1h after period end) and were dropped — a
systematic under-bill of every paying customer's period tail.

The **tail-flush** (S4.5, `invoice.created` hook) closes that P0: when Stripe creates the period's draft
invoice, we finalize the org's **complete** tail days (those whose whole UTC day ended at/before the period
end) and report them within the draft grace, where a second probe confirmed they land on the invoice.

## decision

The tail-flush finalizes+reports every complete tail day but **excludes the boundary day** — the single UTC
day that straddles the period-end instant. That day is left to the next period's normal reporting.

We **accept the boundary day as a bounded residual and do NOT build the exact split ("F4")**:

- The residual is at most **one UTC day of usage per period per customer**. For an included-volume customer
  (e.g. Pro's 500,000 events/month) one day is well inside the allowance — zero revenue impact. It surfaces
  only as forgone **overage** for an overage-heavy customer, on the order of 1/30 of a month's overage.
- Recovering it exactly (bill the pre-period-end slice of the boundary day in the closing period, the rest
  in the next) requires splitting a single UTC-day usage bucket at a sub-day instant: a new `boundary_splits`
  marker, an outbox primary-key change so `:pre`/`:post` meter events coexist, a change to the reporter's
  core `{org}:{day}` identifier scheme, and sub-day counts read from the raw tables. That is a large,
  money-critical change to the reporting path for marginal revenue — a poor trade.
- The residual is **monitored, not silent**: the WS1 Stripe transport reconciler
  (`webhook_meter_transport`) compares what we reported to what Stripe aggregated per day and alarms on any
  drift, so the boundary residual is observable and quantified rather than hidden.

Why the boundary day is *excluded* rather than flushed whole: `invoice.created` fires at period end while the
boundary day is still in progress, so finalizing it then would freeze it mid-day and LOSE its remaining
events — worse than deferring it. Reporting the whole day late (the pre-tail-flush behavior) drops it
entirely. Excluding it caps the loss at one day and keeps every complete day exact.

## consequences

- Metering is exact for every complete day; the only inexactness is ≤1 boundary day per period, biased toward
  under-count (never over-count), bounded, and reconciler-visible.
- If a future overage-heavy customer base makes the residual material, the F4 exact-split design is recorded
  (internal `s4-billing-metering-lane` memo) and can be built as a focused effort. Until then, day-granular
  reporting + the tail-flush is the correct, reliable posture.
