// Typed reader for the activation weekly review (marketing measurement layer). The queryable primitive over
// the SECURITY DEFINER activation_weekly_review() function (migration 0092): the founder's one-time funnel
// (signups → capture → forward + TTFV) and the weekly-recurrence north-star (activated_orgs), one row per
// ISO week, AGGREGATES ONLY — no org_id, no PII (ADR-0125). Mirrors readDeliveryStatsSeries: a thin, typed
// wrapper that a caller (an ops runner today; a founder-gated endpoint later) invokes over an OWNER
// connection.

import type { Sql } from "./client";

/** One ISO-week row of the activation weekly review. Every count is a JS number (the SQL returns bigints as
 *  strings over postgres.js, coerced here). Aggregate-only — never an org_id or any PII. */
export interface ActivationWeeklyReviewRow {
  /** UTC-Monday of the ISO week, as a YYYY-MM-DD string. */
  readonly isoWeek: string;
  /** Cohort funnel (keyed by SIGNUP week): orgs that signed up this week. */
  readonly signups: number;
  /** …of whom ever reached first capture. */
  readonly reachedCapture: number;
  /** …of whom ever reached first forward (the activation act). */
  readonly reachedForward: number;
  /** Weekly-recurrence NSM (keyed by ACTIVITY week): distinct orgs that BOTH captured and forwarded this
   *  week — "weekly activated developers". */
  readonly activatedOrgs: number;
  /** reached_forward / signups — a real cohort conversion, bounded [0,1]. */
  readonly activationRate: number;
  /** Median hours from signup to first forward, over this signup cohort; null if none forwarded. */
  readonly ttfvMedianHours: number | null;
  /** p90 of the same time-to-first-value; null if none forwarded. */
  readonly ttfvP90Hours: number | null;
}

/**
 * Read the activation weekly review, one row per ISO week, oldest→newest. Calls activation_weekly_review()
 * (SECURITY DEFINER, migration 0092), which reads the three activation tables cross-org via `to webhook_owner`
 * policies and excludes activation_org_exclusions.
 *
 * `sql` must be a connection holding EXECUTE on that function. 0092 revokes it from PUBLIC and 0093 grants it
 * back to exactly one role, so that means the SCHEMA OWNER or `webhook_activation_reviewer` — the
 * least-privilege reader the internal endpoint opens over its Hyperdrive, and the caller this is written for.
 * webhook_app is denied by design (private-by-default — platform-wide aggregates never reach the request-path
 * role), and so is a managed provider role that merely holds owner MEMBERSHIP without inheriting it (#717).
 * The result carries no org_id and no PII.
 */
export async function readActivationWeeklyReview(sql: Sql): Promise<ActivationWeeklyReviewRow[]> {
  const rows = await sql<
    Array<{
      iso_week: Date;
      signups: string | number;
      reached_capture: string | number;
      reached_forward: string | number;
      activated_orgs: string | number;
      activation_rate: string | number;
      ttfv_median_hours: string | number | null;
      ttfv_p90_hours: string | number | null;
    }>
  >`
    select iso_week, signups, reached_capture, reached_forward, activated_orgs,
           activation_rate, ttfv_median_hours, ttfv_p90_hours
      from activation_weekly_review()
     order by iso_week`;
  return rows.map((r) => ({
    isoWeek: r.iso_week.toISOString().slice(0, 10),
    signups: Number(r.signups),
    reachedCapture: Number(r.reached_capture),
    reachedForward: Number(r.reached_forward),
    activatedOrgs: Number(r.activated_orgs),
    activationRate: Number(r.activation_rate),
    ttfvMedianHours: r.ttfv_median_hours === null ? null : Number(r.ttfv_median_hours),
    ttfvP90Hours: r.ttfv_p90_hours === null ? null : Number(r.ttfv_p90_hours),
  }));
}
