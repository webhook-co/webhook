# ADR-0110: Cancellation refunds the base fee by USAGE, not by calendar days

- **Status:** Accepted
- **Date:** 2026-07-11
- **Supersedes/relates:** ADR-0004 (metering + one-time free allowance), ADR-0108 (graduated overage pricing)

## Context

Our Terms promise that when you cancel, we return the unused part of the **prepaid plan fee**. The question is
what "unused" means. The industry default is time: refund the fraction of the billing period you didn't use.
That default is wrong for us, and it is wrong in a way that punishes exactly the customers we want.

We sell **volume**, not time. A customer pays a base fee that includes N events. Someone who signs up, pushes
20 events in three weeks, and cancels has consumed essentially nothing of what they bought — but a
time-prorated refund would return only ~25% of their fee, because they held the subscription for most of the
month. Meanwhile a customer who burns their entire included volume in two days and cancels would get ~93%
back. Time-proration refunds the wrong person.

There is a second problem: overage is billed **in arrears**. There is no prepaid overage to give back, so the
base fee is the only prepaid money in the system, and it is the only thing a refund can touch.

## Decision

**Refund the base fee in proportion to the INCLUDED VOLUME the customer did not consume:**

```
refund = base × (1 − consumed / included)
```

- `consumed` = billable events in the current period (`sumPeriodEventUsage` — the same basis the soft cap
  enforces on, so the refund can never disagree with what we metered them for).
- `included` = the subscription's own `event_cap` — what the customer actually *bought*. Deliberately not the
  `org_limits` mirror, whose decrease-defer window can hold a different value mid-cycle. A wrong denominator
  is wrong money.
- `base` = read from the **paid Stripe invoice** at runtime. No price or amount figure exists in this repo
  (`parseStripePlans` rejects a config carrying an `amount`), so the only honest source of what we charged is
  the invoice that charged it.

**Cancellation is immediate**, not end-of-period. The two go together: if you keep access until the period
ends, you have consumed the period and there is nothing unused to refund. (The Terms previously said both, and
were self-contradictory; ADR-0110 resolves that in favour of immediate + refund.)

Degenerate inputs all fail **closed** to a zero refund rather than guessing: an unlimited plan (no
denominator), a zero cap, a customer who overshot their included volume (they owe *us* overage), a
subscription that never billed (a trial), or a credit-settled invoice with no charge to reverse.

## Consequences

**Two orderings are load-bearing, and both are about money.**

1. **Cancel first, then refund.** If the refund leg fails after a successful cancel, we owe a debt that is
   detectable, audited, and retriable. If we refunded first and the cancel then failed, we would keep
   **charging** a customer we had already paid back. Owing someone money is recoverable; continuing to bill
   them after they cancelled is a breach of the exact thing they asked us to stop. The failure is surfaced as
   its own `refund_failed` status — distinct from `error` — because a user told "cancellation failed" would
   cancel again while we still owe them.

2. **The refund's idempotency key is derived from the paid INVOICE**, not from a per-click nonce. Two
   independent cancel attempts against the same invoice therefore collapse to **one** refund at Stripe. A
   nonce would mint a fresh key per attempt and refund the same money twice.

**Stripe's own cancel-time proration is switched OFF** (`prorate=false`). Our refund is usage-based; letting
Stripe also credit the unused *time* would pay the customer twice for the same period.

**⚠️ Operational requirement — the Stripe Customer Portal's "cancel subscription" must stay DISABLED in the
Portal configuration.** Cancelling there ends the subscription with **no refund**, silently bypassing the
promise in the Terms. Cancellation must flow only through the in-app path that computes the refund.

**Cost:** a customer who barely used the service gets most of their money back, so a low-usage month is close
to free for them. That is the point — it is the honest reading of "you only pay for what you use", and it is
the same principle the pricing page already sells. We would rather refund a light user than keep money we did
not earn.

The whole path stays **dark** behind `BILLING_MODE` (unset → `off`), like every other Stripe surface.
