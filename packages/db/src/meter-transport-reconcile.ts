// WS1 Stripe TRANSPORT reconciliation. The existing F6 oracle (meter-reconcile.ts) validates OUR frozen
// count against OUR raw events. It cannot see the other side of the wire: whether the meter events we POSTed
// to Stripe were actually AGGREGATED. The outbox `sent` state only means "Stripe returned 2xx", and
// `stripe_meter_event_id` is just our echoed identifier — a meter event Stripe silently dropped is invisible
// until an invoice looks wrong.
//
// This reconciler closes that blind spot: for each org, compare what we TOLD Stripe (the outbox `sent` rows,
// per UTC day) to what Stripe SAYS it aggregated (meter event summaries, day-grouped). It runs under the
// dedicated read-only webhook_meter_transport role and alarms on any drift — it never self-heals (an
// auto-adjustment on live money is a separate, human decision). The Stripe read is an injected seam, so the
// comparison logic is testable against ephemeral Postgres without a network.
//
// Two time facts shape it: Stripe's summaries are EVENTUALLY CONSISTENT, so a day is only reconciled once it
// is older than `settleLagMs` (a TIME gate, never a value tolerance — a numeric fudge would mask a real
// partial drop). And `stripe_meter_reports.day` is a `date`, so day comparison needs no TZ pinning.

import type { Sql } from "./client";
import { safeErr } from "./meter-reporter";

/**
 * Reads a customer's Stripe meter-event summaries over a range, day-grouped. Injected so the DB comparison
 * is testable without HTTP; the production adapter wraps `StripeClient.listMeterEventSummaries`.
 */
export interface MeterSummaryReader {
  listDaySummaries(
    customer: string,
    startSec: number,
    endSec: number,
  ): Promise<{ startSec: number; aggregated: number }[]>;
}

export interface MeterTransportDeps {
  /** webhook_meter_transport connection — cross-org, read-only (outbox `sent` rows + org→customer map). */
  readonly audit: Sql;
  /** The Stripe-summary reader seam. */
  readonly reader: MeterSummaryReader;
  /** Injected wall clock (ms). */
  readonly now: number;
  /** Only reconcile days whose window ended at least this long ago (Stripe aggregation settle lag). */
  readonly settleLagMs: number;
  /** How many days back to reconcile. */
  readonly lookbackDays: number;
  /** Max drifts surfaced per pass (`capped` flags truncation). */
  readonly limit: number;
  /** Max ORGS reconciled per pass — bounds the one-Stripe-call-per-org fan-out. */
  readonly orgLimit: number;
  /**
   * Resume point: only orgs ordered AFTER this id are considered. A plain LIMIT without this would
   * reconcile the same head of the org list every tick and never reach the tail, while every counter
   * still read clean. Null/empty starts from the beginning.
   */
  readonly cursor?: string | null;
  /** Optional structured logger; only non-PII fields (org id, day, counts) are passed. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** One (org, day) where what we sent Stripe disagrees with what Stripe aggregated. */
export interface MeterTransportDrift {
  readonly orgId: string;
  /** The UTC day (YYYY-MM-DD). */
  readonly day: string;
  /** The value we POSTed to Stripe for that day (outbox `sent.event_count`). */
  readonly reported: number;
  /** What Stripe aggregated; `null` = Stripe has NO summary for the day (a full drop). */
  readonly stripe: number | null;
}

export interface MeterTransportResult {
  /** Settled `sent` days (of successfully-read orgs) that were compared. */
  readonly daysChecked: number;
  /** Distinct orgs actually reconciled (Stripe read succeeded). Excludes errored orgs. */
  readonly orgsChecked: number;
  /** The days whose sent value disagreed with Stripe's aggregate (empty = transport is consistent). */
  readonly mismatches: readonly MeterTransportDrift[];
  /** Distinct orgs skipped because they have sent rows but no `billing_customers` mapping. */
  readonly skippedNoCustomer: number;
  /** Distinct orgs whose Stripe read FAILED — an alarm signal, NOT a clean reconcile (they weren't checked). */
  readonly erroredOrgs: number;
  /** True when the drift list hit `limit` (truncated) — widen the pass. */
  readonly capped: boolean;
  /**
   * Where the next pass should resume. The last org id of a FULL page (more may remain), or null when the
   * page was short — meaning the end of the list was reached and the next pass must wrap to the start.
   * Returning the last id on a short page would pin the cursor past the end and silently reconcile nothing.
   */
  readonly nextCursor: string | null;
}

export const DEFAULT_TRANSPORT_LOOKBACK_DAYS = 35;
export const DEFAULT_TRANSPORT_LIMIT = 1000;
/**
 * Max ORGS reconciled per pass. This is the real fan-out bound: the loop issues one Stripe
 * `listMeterEventSummaries` call per org, so without it the external call count scales with the paying
 * customer base — inside an invocation whose subrequest budget is shared with fourteen other crons.
 * `DEFAULT_TRANSPORT_LIMIT` bounds only the surfaced DRIFT list and never bounded the calls.
 */
export const DEFAULT_TRANSPORT_ORG_LIMIT = 200;
/** Default Stripe-aggregation settle lag before a day is reconciled (24h — summaries are eventually consistent). */
export const DEFAULT_TRANSPORT_SETTLE_LAG_MS = 86_400_000;

const DAY_MS = 86_400_000;

/** Sorts below every generated uuid; used as the "start from the beginning" cursor sentinel. */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** UTC-midnight `YYYY-MM-DD` of the instant `ms`. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
/** UTC-midnight unix seconds of a `YYYY-MM-DD`. */
function daySec(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
}

export async function reconcileStripeTransport(
  deps: MeterTransportDeps,
): Promise<MeterTransportResult> {
  // horizon = oldest day to reconcile; settledBefore = first day still inside the settle lag (exclusive).
  // A day D is settled iff its end (D+1 00:00 UTC) <= now - settleLag, i.e. D < utcDay(now - settleLag).
  const horizon = utcDay(deps.now - deps.lookbackDays * DAY_MS);
  const settledBefore = utcDay(deps.now - deps.settleLagMs);

  // PHASE 1 — take a BOUNDED page of orgs. The fan-out below is one Stripe call per org, so the bound has
  // to reach SQL: filtering after the fact would still pull every eligible row across the wire and, worse,
  // would tempt a later edit into dropping it. Ordered by org id and resumed from `cursor`, so successive
  // passes rotate through the whole list instead of re-checking the same head forever.
  // `org_id` is a uuid column, so the start sentinel must itself be a valid uuid — an empty string is a
  // `invalid input syntax for type uuid` error, not an empty filter. The all-zero uuid sorts below every
  // generated one and can never be a real org, so `> ZERO_UUID` means "from the beginning".
  const after = deps.cursor && deps.cursor.length > 0 ? deps.cursor : ZERO_UUID;
  const orgPage = await deps.audit<{ org_id: string }[]>`
    select distinct r.org_id
    from stripe_meter_reports r
    where r.status = 'sent'
      and r.day >= ${horizon}::date
      and r.day < ${settledBefore}::date
      and r.org_id > ${after}
    order by r.org_id
    limit ${deps.orgLimit}`;

  const pageOrgIds = orgPage.map((o) => o.org_id);
  // A SHORT page means the end of the list was reached: wrap, so the next pass starts from the beginning.
  // Pinning the cursor at the tail would leave every later pass reconciling nothing, counters still clean.
  const nextCursor =
    pageOrgIds.length === deps.orgLimit && pageOrgIds.length > 0
      ? (pageOrgIds[pageOrgIds.length - 1] as string)
      : null;

  if (pageOrgIds.length === 0) {
    return {
      daysChecked: 0,
      orgsChecked: 0,
      mismatches: [],
      skippedNoCustomer: 0,
      erroredOrgs: 0,
      capped: false,
      nextCursor,
    };
  }

  // PHASE 2 — the settled rows for exactly that page.
  // `in ${audit([...])}` expands the array into a real parameterized IN list. NOT `= any(${ids}::uuid[])`:
  // that cast makes the driver serialize the array as a bare comma-joined string and Postgres rejects it
  // ("malformed array literal") — the same trap already documented in api-keys.ts. A real-Postgres test
  // caught it here too; the mocked one I wrote first did not.
  const rows = await deps.audit<
    { org_id: string; day: string; sent: string; customer: string | null }[]
  >`
    select r.org_id,
           to_char(r.day, 'YYYY-MM-DD') as day,
           r.event_count::text as sent,
           c.stripe_customer_id as customer
    from stripe_meter_reports r
    left join billing_customers c on c.org_id = r.org_id
    where r.status = 'sent'
      and r.day >= ${horizon}::date
      and r.day < ${settledBefore}::date
      and r.org_id in ${deps.audit(pageOrgIds)}
    order by r.org_id, r.day`;

  // Split: orgs we can reconcile (have a customer) vs orgs with a sent tail but no customer mapping.
  const noCustomerOrgs = new Set<string>();
  const byOrg = new Map<string, { customer: string; days: { day: string; sent: number }[] }>();
  for (const r of rows) {
    if (!r.customer) {
      noCustomerOrgs.add(r.org_id);
      continue;
    }
    const entry = byOrg.get(r.org_id) ?? { customer: r.customer, days: [] };
    entry.days.push({ day: r.day, sent: Number(r.sent) });
    byOrg.set(r.org_id, entry);
  }

  const drifts: MeterTransportDrift[] = [];
  let daysChecked = 0;
  let orgsChecked = 0;
  let erroredOrgs = 0;

  // Bound the drift LOG alongside the returned list: a systematic misalignment must not flood logs with
  // one line per settled day while the surfaced result is already capped at `limit`.
  const emit = (d: MeterTransportDrift): void => {
    if (drifts.length < deps.limit) deps.log?.("metering.stripe_reconcile.drift", { ...d });
    drifts.push(d);
  };

  for (const [orgId, { customer, days }] of byOrg) {
    const sentByDay = new Map(days.map((d) => [d.day, d.sent]));
    // One summary-list call per org (day-grouped): O(orgs), not O(org·days). The range spans our sent days,
    // so any Stripe-only day we compare is bracketed by settled sent days (never an unsettled false drift).
    const dayStrs = days.map((d) => d.day);
    const startSec = daySec(dayStrs.reduce((a, b) => (a < b ? a : b)));
    const endSec = daySec(dayStrs.reduce((a, b) => (a > b ? a : b))) + DAY_MS / 1000;

    let byDay: Map<string, number>;
    try {
      // Stripe meter-event summaries with value_grouping_window='day' are UTC-day windows (the API mandates
      // UTC-midnight start/end for day granularity), so utcDay() lines up 1:1 with our UTC-day outbox rows.
      // The WS2 probe empirically confirms this against the live account before we trust the alarm.
      const summaries = await deps.reader.listDaySummaries(customer, startSec, endSec);
      byDay = new Map(summaries.map((s) => [utcDay(s.startSec * 1000), s.aggregated]));
    } catch (err) {
      // One org's Stripe failure must not sink the pass — but it must NOT masquerade as a clean reconcile
      // either. Count it as ERRORED (surfaced in the summary as an alarm), never as checked; a persistent
      // 400/500 would otherwise report "done, 0 drift" forever while reconciling nothing.
      // safeErr (shared with the reporter): NEVER the raw message — a Stripe error's text can carry
      // external billing ids (cus_…/sub_…). Log a category + Stripe's structured status/type/code only.
      erroredOrgs += 1;
      deps.log?.("metering.stripe_reconcile.reader_error", { orgId, ...safeErr(err) });
      continue;
    }

    orgsChecked += 1;
    daysChecked += days.length;

    // Compare over the UNION of days we SENT and days Stripe AGGREGATED. Iterating only our sent days would
    // miss a day Stripe has a value for that we never reported — a phantom / mis-timestamped charge the
    // customer would be billed for, invisible to both this check and the F6 our-count-vs-our-usage oracle.
    const allDays = [...new Set([...sentByDay.keys(), ...byDay.keys()])].sort();
    for (const day of allDays) {
      const sent = sentByDay.get(day) ?? 0;
      const stripe = byDay.has(day) ? (byDay.get(day) as number) : null;
      if (stripe !== sent) emit({ orgId, day, reported: sent, stripe });
    }
  }

  const capped = drifts.length > deps.limit;
  const mismatches = capped ? drifts.slice(0, deps.limit) : drifts;

  return {
    daysChecked,
    orgsChecked,
    mismatches,
    skippedNoCustomer: noCustomerOrgs.size,
    erroredOrgs,
    capped,
    nextCursor,
  };
}
