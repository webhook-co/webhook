// The S4.4c outbound meter-reporter. Runs in the metering cron (gated on BILLING_MODE), AFTER the rollup
// has frozen yesterday's usage. For each PAYING org it (1) PRODUCES stripe_meter_reports outbox rows from
// FINALIZED daily usage — an immutable, billable snapshot (F1), never an open or zero day, never a day
// before the org subscribed — then (2) DRAINS the outbox to a Stripe Billing Meter through the
// pending → sending → sent state machine. identifier = {org}:{day} is Stripe's native dedup key AND the
// HTTP Idempotency-Key (F5), so a retried report of a day is a no-op — a day is never double-billed.
//
// The Stripe call happens OUTSIDE the tenant tx (a DB transaction is never held across a network call):
// claim (flip to sending, count the attempt) in one small tx, report to Stripe, finalize (sent) in
// another. A send failure leaves the row 'sending' and retryable — the next pass resends the same
// identifier, which Stripe dedups. Enumeration of paying orgs is cross-org via webhook_meter (migration
// 0045, SELECT-only); every per-org read/write is webhook_app under RLS. Free orgs have no subscription
// row, so they are never enumerated and never reported.

import { StripeError } from "@webhook-co/shared";

import { withTenant, type Sql } from "./client";
import { readBillingCustomerId } from "./reads";

/**
 * A log-SAFE view of a failure. NEVER the raw message: a Stripe error's text can carry external billing
 * object ids (cus_…/sub_…) and a Postgres error's detail can echo row values — on the billing path we log
 * a category + Stripe's structured (non-PII) status/type/code only. orgId (an opaque internal UUID) stays,
 * matching the existing metering-cron logging; it is not PII and is needed to trace which org failed.
 */
function safeErr(err: unknown): Record<string, unknown> {
  if (err instanceof StripeError) {
    return {
      errorKind: "stripe",
      stripeStatus: err.status,
      stripeType: err.stripeType,
      stripeCode: err.stripeCode,
    };
  }
  return { errorKind: err instanceof Error ? err.name : "unknown" };
}

/** The Stripe send seam (the outbound client's reportMeterEvent structurally satisfies this). */
export interface MeterReportSink {
  reportMeterEvent(args: {
    eventName: string;
    customer: string;
    value: number;
    identifier: string;
    timestamp?: number;
  }): Promise<{ identifier?: string }>;
}

export interface MeterReporterDeps {
  /** webhook_meter connection — cross-org enumeration of paying orgs ONLY (read-only, column-scoped). */
  readonly meter: Sql;
  /** webhook_app connection — per-org read (usage/customer) + outbox write, under RLS. */
  readonly app: Sql;
  /** The Stripe meter send seam (BILLING_MODE gating is the caller's — this client is mode-agnostic). */
  readonly stripe: MeterReportSink;
  /** The Stripe Billing Meter's event_name (config) — which meter the usage counts against. */
  readonly eventName: string;
  /** Injected wall clock (ms) — reserved for future period-bound logic; kept for determinism/testability. */
  readonly now: number;
  /** Max paying orgs one pass processes (fairly ordered so the tail isn't starved). */
  readonly limit: number;
  /** Optional structured logger; only non-PII fields (org id, day, counts) are passed. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface MeterReporterResult {
  /** Paying orgs enumerated this pass. */
  readonly orgsProcessed: number;
  /** Outbox rows newly inserted (pending) this pass. */
  readonly produced: number;
  /** Outbox rows successfully reported to Stripe this pass. */
  readonly sent: number;
  /** Send attempts that errored (retryable — the same identifier resends next pass; Stripe dedups). */
  readonly failed: number;
  /** Orgs with unsent rows but no Stripe customer yet — drain skipped, rows stay pending (retryable). */
  readonly skippedNoCustomer: number;
  /** True when the paying-org set hit `limit` (truncated) — a persistently-capped reporter needs a
   *  higher limit / cadence. Correctness is unaffected (idempotent, eventually consistent). */
  readonly capped: boolean;
}

/** Default cap on paying orgs one reporter pass processes. */
export const DEFAULT_METER_REPORTER_LIMIT = 1000;

/** The unix SECONDS of 00:00 UTC of `dayIso` (YYYY-MM-DD) — the meter event's period-placing timestamp. */
export function meterEventTimestampSeconds(dayIso: string): number {
  return Math.floor(Date.parse(`${dayIso}T00:00:00Z`) / 1000);
}

export async function runMeterReporter(deps: MeterReporterDeps): Promise<MeterReporterResult> {
  // Enumerate PAYING orgs (a non-canceled subscription). random() ordering gives every candidate an equal
  // per-pass chance (no fixed-order tail starvation); at current scale the set is far below `limit`.
  //
  // KNOWN GAP (owned by S4.5): excluding 'canceled' means an org's finalized-but-unreported TAIL (the last
  // ~settleDays of usage, which can't finalize until after the cancel) is never reported here. This is
  // largely inherent to Stripe's lifecycle — meter events reported AFTER the final invoice aren't invoiced
  // anyway — so the correct home for recovering it is the S4.5 inbound webhook: FLUSH the tail on the
  // invoice.upcoming/finalized hook BEFORE Stripe closes the final invoice, and let the reconciliation
  // oracle (F6) alarm on any residual usage-vs-Stripe drift. Deliberately NOT patched with a half-measure
  // here (a "recently-canceled" window would still miss un-finalized days and risk post-invoice no-op sends).
  const rows = await deps.meter<Array<{ org_id: string; created_at: string }>>`
    select org_id, created_at::text as created_at
    from billing_subscriptions
    where status <> 'canceled'
    order by random()
    limit ${deps.limit}`;
  const capped = rows.length >= deps.limit;

  let produced = 0;
  let sent = 0;
  let failed = 0;
  let skippedNoCustomer = 0;

  for (const { org_id: orgId, created_at } of rows) {
    // The meter FLOOR: never bill a day before the org subscribed (pre-subscription Free usage).
    const floorDay = created_at.slice(0, 10);
    try {
      // Phase 1 (one tenant tx, NO network): produce pending rows from finalized usage, read the customer,
      // and collect the unsent days to drain.
      const phase1 = await withTenant(deps.app, orgId, async (tx) => {
        const producedRows = await tx<{ day: string }[]>`
          insert into stripe_meter_reports (org_id, day, event_count, identifier)
          select u.org_id, u.window_start::date, u.event_count,
                 u.org_id::text || ':' || (u.window_start::date)::text
          from usage u
          where u.finalized_at is not null
            and u.event_count > 0
            and u.window_start::date >= ${floorDay}::date
            and not exists (
              select 1 from stripe_meter_reports r
              where r.org_id = u.org_id and r.day = u.window_start::date)
          on conflict (org_id, day) do nothing
          returning day::text as day`;
        const customer = await readBillingCustomerId(tx);
        const unsent = await tx<{ day: string; event_count: string; identifier: string }[]>`
          select day::text as day, event_count::text as event_count, identifier
          from stripe_meter_reports where status <> 'sent' order by day`;
        return { customer, unsent, newlyProduced: producedRows.length };
      });
      produced += phase1.newlyProduced;

      if (phase1.unsent.length === 0) continue;
      if (!phase1.customer) {
        // A subscription exists but the customer link hasn't been recorded yet (the inbound webhook is
        // eventually consistent). Leave the rows pending; a later pass drains them once the link lands.
        skippedNoCustomer += 1;
        deps.log?.("metering.report.no_customer", { orgId });
        continue;
      }
      const customer = phase1.customer;

      // Phase 2 (per day, OUTSIDE the tenant tx): claim → report to Stripe → finalize.
      for (const row of phase1.unsent) {
        const claimed = await withTenant(
          deps.app,
          orgId,
          (tx) => tx<{ day: string }[]>`
            update stripe_meter_reports set status = 'sending', attempts = attempts + 1, updated_at = now()
            where org_id = ${orgId} and day = ${row.day} and status <> 'sent'
            returning day`,
        );
        if (claimed.length === 0) continue; // a concurrent pass already sent it
        try {
          const ack = await deps.stripe.reportMeterEvent({
            eventName: deps.eventName,
            customer,
            value: Number(row.event_count),
            identifier: row.identifier,
            timestamp: meterEventTimestampSeconds(row.day),
          });
          await withTenant(
            deps.app,
            orgId,
            (tx) => tx`
              update stripe_meter_reports
              set status = 'sent', stripe_meter_event_id = ${ack.identifier ?? row.identifier},
                  sent_at = now(), updated_at = now()
              where org_id = ${orgId} and day = ${row.day}`,
          );
          sent += 1;
        } catch (err) {
          // Retryable: the row stays 'sending' (attempt counted). Next pass resends the SAME identifier;
          // Stripe dedups within its window, so a partially-landed report is never double-billed (F5).
          failed += 1;
          deps.log?.("metering.report.send_failed", { orgId, day: row.day, ...safeErr(err) });
        }
      }
    } catch (err) {
      deps.log?.("metering.report.org_failed", { orgId, ...safeErr(err) });
    }
  }

  return { orgsProcessed: rows.length, produced, sent, failed, skippedNoCustomer, capped };
}
