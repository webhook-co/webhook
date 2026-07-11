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
- `base` and `included` both come from **the invoice that actually took the money** — see the invariant below.

## The invariant: every figure comes from the invoice, never from live subscription state

This is the load-bearing rule, and it was learned the hard way. The first implementation read the base price
from the *live* subscription and searched for the most recent *paid* invoice. A security review found **four**
ways that moves wrong money, and all four share one root cause: live state and the money that was taken can
disagree.

| Failure | What live state says | What actually happened |
| --- | --- | --- |
| **`past_due` cancel** | sub is entitled (`past_due` is in `BILLING_ACTIVE_STATUSES`) | the current period's invoice is `open` — never paid. "Latest *paid* invoice" reaches back to the **previous, fully consumed** period, and this period's ~0 usage refunds ~100% of it. **Money out of nothing.** |
| **Mid-cycle plan switch** (ADR-0108/WS4, `create_prorations` issues no invoice) | items hold the **new** price | the paid invoice holds the **old** one → no line matches → a silent **€0 refund** for every customer who ever switched plans, under a banner promising their money back |
| **A coupon** | line `amount` = 1900 | only 950 was captured — line `amount` is **pre-discount**; the discount lives in `discount_amounts`. Refunding a proportion of 1900 can exceed the charge. |
| **Credit-settled invoice** | invoice is `paid` | there is no `charge` to reverse. Reporting success promises a refund *and writes a signed audit record of one that never happened*. |

So the rules are:

- Anchor to **`subscription.latest_invoice`** — *this* period's invoice, paid or not — never a search for the
  latest paid one. If it isn't `paid`, nothing was prepaid for this period and nothing comes back. That is the
  correct answer for a `past_due` cancellation.
- **Sum** every base line net of its discounts. Don't take the first: a proration invoice carries several lines
  on the same price, and one can be a **negative** credit.
- Take `included` from **that invoice's base price** (`price.metadata.event_cap`), not the live subscription's
  mirrored cap — after a plan switch the mirror describes a different plan entirely.
- Clamp the result to `invoice.amount_paid` **and** to the charge's remaining headroom
  (`charge.amount − charge.amount_refunded`) — support or the Portal may already have refunded part of it.
- `base` figures are read from Stripe at runtime. No price or amount exists in this repo (`parseStripePlans`
  rejects a config carrying an `amount`), so the only honest source of what we charged is the invoice that
  charged it.

**Never claim a refund we didn't make.** When money was taken but we cannot issue the refund — no charge to
reverse, or no recognisable base line (a legacy/archived price) — we still cancel, but return a distinct
`refund_unavailable` status and audit the debt. Telling a user their money is on its way when it isn't is worse
than telling them nothing.

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
   concurrent cancel attempts against the same invoice therefore collapse to **one** refund at Stripe. A nonce
   would mint a fresh key per attempt and refund the same money twice.

   Note the honest limit: there is **no automatic retry** of a failed refund. A re-cancel sees the subscription
   already cancelled and stops before the refund leg, so recovery today is a human reading the
   `subscription_canceled_refund_failed` audit row and refunding in Stripe. A refund-recovery job (re-drive
   those audit rows, checking Stripe for an existing refund on the charge first) is **follow-up work** — this
   path must not be described as self-healing until it exists.

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
