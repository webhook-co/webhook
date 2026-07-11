# ADR-0112: No automatic refunds; cancellations and downgrades land at the period end

- **Status:** Accepted
- **Date:** 2026-07-11
- **Relates to:** ADR-0004 (metering + the one-time free allowance), ADR-0108 (graduated overage pricing)

## Context

A paid plan is billed **in advance** for the period; overage is metered and billed **in arrears**. That leaves
exactly one pot of prepaid money — the plan fee — and the question is what happens to it when a customer
cancels, downgrades, or switches plans mid-period.

An earlier draft of this system tried to answer that by computing an automatic, usage-proportional refund of
the plan fee on cancellation. That was wrong, and the Terms had drifted to promise it. It is being reversed
here before any of it shipped.

## Decision

**We never refund automatically.** No code path moves money back to a customer on its own.

Instead, nothing is cut short:

- **Cancellation** takes effect at the **end of the current billing period**. The customer keeps the plan they
  paid for until it runs out, then returns to the free tier. (Because the free allowance is one-time, capture
  stays paused if it is already spent.)
- **Downgrades** take effect at the **end of the current billing period** too, via a Stripe **subscription
  schedule**: phase 0 is the period already bought, phase 1 is the smaller plan starting the moment phase 0
  ends. Sent with `proration_behavior: none`.
- **Upgrades** are the one exception: they apply **immediately**, with the difference prorated onto the next
  invoice. A customer who has hit their cap needs headroom *now*; making them wait for renewal is a bad
  experience and a lost sale. The money moves *toward* us, so it raises none of the concerns below.
- **Overage** is billed in arrears, so there is never unused overage to return.

**Refunds are handled by a human, case by case.** If a customer believes they were charged unfairly they email
support and we look at it. That is a deliberate policy choice, and it is stated plainly in the Terms rather
than buried.

## Consequences

**Why "no automatic refund" is a stronger guarantee than it looks.** An automatic refund path is a code path
that moves money out of the business without a human in the loop. A review of the earlier usage-refund design
found **six** distinct ways it would have moved the *wrong* money — refunding a period the customer had already
fully consumed, refunding nothing at all to anyone who had switched plans, over-refunding discounted
subscriptions, and reporting refunds that never happened. Every one of those was a consequence of trying to
reconstruct, from API state, what a human could see at a glance. Not having the code path removes the entire
class.

**A proration credit is a refund by another name.** This is the subtle one, and it is why a downgrade must be
*scheduled* rather than applied immediately with `create_prorations`. An immediate downgrade would (a) take
away volume the customer already paid for, and (b) hand back the remainder as an account credit — money
flowing backward, automatically, without anyone looking at it. `proration_behavior: none` on the schedule is
load-bearing, not a detail.

**Direction is decided in exactly one place** — `isPlanDowngrade` (`packages/shared/src/billing.ts`), ranked by
`SELF_SERVE_PLAN_IDS` declaration order. It **fails closed**: an unrecognised tier counts as a downgrade, so a
legacy or garbage plan id can never take the immediate-*charge* path on a guess. The worst case of failing
closed is that a customer waits until renewal; the worst case of failing open is that we bill them for the
wrong thing.

**Cost:** a customer who cancels the day after renewing pays for that period in full. This is why the Terms say
so plainly, up front and in the plain-language summary, rather than only in clause 6 — and why the door to a
human review is stated in the same breath. We would rather be clear about a firm policy than quietly generous
about a vague one.

**Follow-up (not built):** the dashboard does not yet *persistently* surface a pending downgrade — the user is
told at the moment they schedule it, but a later visit won't show "downgrades to Pro on the 30th". That needs
the pending schedule mirrored locally (or read live from Stripe on the billing page). Tracked separately.
