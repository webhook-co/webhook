// The S4.5 metering TAIL-FLUSH (the invoice.created hook). The hourly reporter only sends FINALIZED days,
// and a day finalizes ~settleDays after it closes — so the last ~settleDays of every period reach Stripe
// AFTER that period's invoice finalizes (~1h after period end), where Stripe silently DROPS them (proven
// empirically, WS2). This flush closes that leak: when Stripe creates the period's draft invoice, we
// FINALIZE the org's complete tail days (up to, but excluding, the boundary day that straddles the period
// end) and DRAIN them to Stripe within the draft grace — where they DO land on the invoice (WS2 probe 2).
//
// It reuses the reporter's exact produce+drain state machine (reportOrgMeter — identifier {org}:{day} =
// Stripe dedup key + HTTP Idempotency-Key), so a flush that races the normal cron never double-bills. It
// runs entirely as webhook_app under RLS (the finalize is a NULL->now() transition the F1 trigger allows;
// the outbox insert/update is webhook_app's already) — no new role. The boundary day itself is left for the
// next period: billing its whole count here would over-bill the post-period-end slice. That one day is the
// bounded residual the transport reconciler (WS1) alarms on.

import { tailFlushCutoff } from "@webhook-co/shared";

import { withTenant, type Sql } from "./client";
import { type OrgMeterDeps, reportOrgMeter } from "./meter-reporter";

/** How many extra days behind the tail to RE-ROLL before finalizing, on top of settleDays. The hourly
 *  rollup keeps recent days rolled; a small margin covers a just-missed event or a skipped cron tick. The
 *  finalize itself still freezes EVERY open day before the boundary — this only bounds the recount work. */
const REROLL_MARGIN_DAYS = 2;

export interface TailFlushDeps extends OrgMeterDeps {
  /** webhook_app connection — the finalize (rollup + freeze) runs here under RLS, same as the drain. */
  readonly app: Sql;
}

export interface TailFlushResult {
  /** Usage-day rows this flush froze (NULL->now). 0 when the tail was already finalized (idempotent re-run). */
  readonly finalized: number;
  /** Outbox rows newly produced from the freshly-finalized tail. */
  readonly produced: number;
  /** Tail days successfully reported to Stripe (should hit the still-open draft invoice). */
  readonly sent: number;
  /** Send attempts that errored — a residual the reconciler will alarm on. */
  readonly failed: number;
  /** 1 if the org has a subscription but no Stripe customer link yet (drain skipped). */
  readonly skippedNoCustomer: number;
}

export interface TailFlushArgs {
  readonly orgId: string;
  /** The subscription day (YYYY-MM-DD) — never finalize/bill a day before the org subscribed. */
  readonly floorDay: string;
  /** The closing period's end, unix MILLISECONDS (from the invoice's period_end * 1000). */
  readonly periodEndMs: number;
  /** The money-safe settle window (shared USAGE_SETTLE_DAYS) — bounds the recount range. */
  readonly settleDays: number;
}

/**
 * Flush ONE org's complete tail for a closing period: re-roll + finalize every open usage day strictly
 * before the boundary day (utcDay(periodEnd)), then produce+drain them to Stripe. Best-effort: a Stripe send
 * failure leaves the row retryable and is reported as `failed` (the caller ACKs anyway — the draft grace is
 * short, and the reconciler alarms on any residual). Idempotent: re-finalize is a no-op (F1), the outbox
 * on-conflict + Stripe identifier dedup make a re-run or a cron race safe against double-billing.
 */
export async function flushOrgTail(
  deps: TailFlushDeps,
  args: TailFlushArgs,
): Promise<TailFlushResult> {
  const { orgId, floorDay, periodEndMs, settleDays } = args;
  // The UTC-midnight start of the boundary day: finalize every open day strictly before it. A meter event
  // stamped at each finalized day's 00:00 UTC is <= period end, so it lands inside the closing period.
  const flushCutoff = tailFlushCutoff(periodEndMs);
  const rerollDays = Math.max(0, settleDays) + REROLL_MARGIN_DAYS;

  // Enumerate the re-roll days (UTC-midnight, oldest→newest) in ONE cheap query, bounded to
  // [max(floor, cutoff-margin), cutoff-1day]. Older days were rolled + finalized when they were recent.
  const rerollDayList = await withTenant(deps.app, orgId, async (tx) => {
    await tx`set local time zone 'UTC'`; // interval '1 day' is exact under UTC (F4)
    const rows = await tx<{ day: string }[]>`
      select to_char(gs, 'YYYY-MM-DD') as day
      from generate_series(
        greatest(${floorDay}::date::timestamptz, ${flushCutoff}::timestamptz - make_interval(days => ${rerollDays})),
        ${flushCutoff}::timestamptz - interval '1 day',
        interval '1 day'
      ) as gs
      order by gs`;
    return rows.map((r) => r.day);
  });

  // Re-roll ONE day per statement, EACH in its own transaction (#637). The old form ran rollup_usage for
  // every day in a SINGLE statement — each call does a full-day count(*) over events + delivery_attempts, so
  // on a real-volume org that one statement was unbounded, and this runs on the REVENUE path (the
  // invoice.created draft-grace flush): if it didn't finish, the tail never reached Stripe, silently. Now
  // each day is independently bounded, and a partial failure is RESUMABLE rather than all-or-nothing: the
  // days that committed stay committed, and a re-run is safe because rollup_usage is IDEMPOTENT — it re-runs
  // the full recount for an already-rolled-but-still-OPEN day (same result, not free), and its
  // `where finalized_at is null` guard makes it a true no-op only for a day already frozen.
  for (const day of rerollDayList) {
    await withTenant(deps.app, orgId, async (tx) => {
      await tx`set local time zone 'UTC'`;
      await tx`select rollup_usage(${day}::date::timestamptz)`;
    });
  }

  // Freeze EVERY still-open day before the boundary (the tail + any older straggler), never the boundary
  // day. NULL->now() only — the F1 trigger forbids re-freezing, and matching the rollup's `is null` guard
  // means we never attempt it. Floor-bounded so a pre-subscription day is never frozen into a billed row. A
  // bounded single-range UPDATE, its own statement after the re-roll (re-run safe: it re-freezes nothing).
  const finalized = await withTenant(deps.app, orgId, async (tx) => {
    await tx`set local time zone 'UTC'`;
    const frozen = await tx`
      update usage set finalized_at = now()
      where finalized_at is null
        and window_start >= ${floorDay}::date
        and window_start < ${flushCutoff}::timestamptz`;
    return frozen.count;
  });

  // Produce + drain the freshly-finalized tail through the reporter's exact idempotent path. One retry on a
  // partial send failure — the draft grace is short and a second attempt is free (claim skips 'sent' rows).
  let outcome = await reportOrgMeter(deps, orgId, floorDay);
  if (outcome.failed > 0) {
    deps.log?.("metering.tail_flush.retry", { orgId, failed: outcome.failed });
    const retry = await reportOrgMeter(deps, orgId, floorDay);
    outcome = {
      produced: outcome.produced + retry.produced,
      sent: outcome.sent + retry.sent,
      failed: retry.failed, // the retry's residual is what actually remains unsent
      skippedNoCustomer: retry.skippedNoCustomer,
    };
  }

  deps.log?.("metering.tail_flush.done", {
    orgId,
    finalized,
    produced: outcome.produced,
    sent: outcome.sent,
    failed: outcome.failed,
  });
  return { finalized, ...outcome };
}
