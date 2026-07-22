import type { Check, HealthStatus } from "@webhook-co/shared/health";

/**
 * Dead-man's-switch heartbeats for scheduled work.
 *
 * Eight crons run across engine, api and auth. None of them was observed by anything: a cron that
 * silently stops firing produces no error, no alert and no trace — the first symptom is a customer
 * noticing that something never happened. This module inverts that. Each job reports after a
 * successful run, and the ABSENCE of a report is the alarm.
 *
 * No status vendor is involved. This is the standard heartbeat convention (Healthchecks.io,
 * Cronitor), implemented over our own KV so it stays ours; the status page merely polls the result.
 */

/** A recorded run. `ok: false` means the job ran and failed, which is distinct from never running. */
export interface Beat {
  readonly ts: number;
  readonly ok: boolean;
}

export interface JobSpec {
  /** Stable id the job posts under. Part of the URL, so keep it slug-safe. */
  readonly id: string;
  /**
   * How long the job may go unreported before it is considered dead. Set to roughly twice the
   * schedule plus slack: one missed run is a blip worth surviving, two is a pattern worth paging on.
   */
  readonly windowMs: number;
  /** What this job does, for the operator reading a failure. */
  readonly label: string;
}

const HOUR = 60 * 60 * 1000;

/**
 * The jobs expected to report.
 *
 * DELIBERATELY NOT EVERY CRON. The estate runs 19 scheduled jobs, but many are gated on OPTIONAL
 * bindings — a feature that has not been provisioned simply never runs, and registering it would
 * render this component permanently red for a job that is not supposed to fire. Every job listed
 * here runs unconditionally on its schedule.
 *
 * The unlisted jobs still report (the call sites are harmless and dark by default); they are just
 * not graded. Promote one here once its binding is provisioned in production.
 *
 * ENGINE JOBS ARE NOT HERE YET. apps/engine dispatches its crons in a shape that
 * `scripts/cron-dispatch-guard.mjs` asserts precisely -- each `ctx.waitUntil` unit must carry a
 * `.catch()` logging an EXACT string that production alerts are keyed on. Wrapping those call sites
 * deleted those catches, so the guard (correctly) refused it. Adding engine heartbeats means teaching
 * that guard the wrapped shape, which is a change to a safety guard and belongs in its own PR.
 */
export const REGISTERED_JOBS: readonly JobSpec[] = [
  { id: "notification-drain", windowMs: 3 * HOUR, label: "auth: notification drain (hourly)" },
  {
    id: "auth-expiry-sweep",
    windowMs: 26 * HOUR,
    label: "auth: cross-org expiry sweep (daily 04:00)",
  },
];

export const KV_BEAT_PREFIX = "beat:";
export const beatKey = (jobId: string) => `${KV_BEAT_PREFIX}${jobId}`;

/** Is `jobId` one this deployment expects? Unknown ids are rejected rather than silently stored. */
export function isRegisteredJob(jobId: string): boolean {
  return REGISTERED_JOBS.some((j) => j.id === jobId);
}

/**
 * Grade one job.
 *
 * A MISSING beat is `fail`, not `warn`. For a dead-man's switch the absence of evidence *is* the
 * alarm — a job that has never reported is indistinguishable from one that died before its first
 * run, and grading it `warn` would let a permanently dead cron sit yellow forever. The cost is a
 * brief red window on first deploy, which is honest: at that moment we genuinely have no evidence.
 */
export function jobStatus(spec: JobSpec, beat: Beat | null, now: number): HealthStatus {
  if (beat === null) return "fail";
  if (!beat.ok) return "fail";
  return now - beat.ts > spec.windowMs ? "fail" : "pass";
}

/** Parse a stored beat, treating anything malformed as absent rather than throwing. */
export function parseBeat(raw: string | null): Beat | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { ts, ok } = parsed as { ts?: unknown; ok?: unknown };
    if (typeof ts !== "number" || !Number.isFinite(ts) || typeof ok !== "boolean") return null;
    return { ts, ok };
  } catch {
    return null;
  }
}

/** The store the checks read from — narrowed to what they use so tests need no KV. */
export interface BeatStore {
  get(key: string): Promise<string | null>;
}

/** One named check per registered job, so a failure names the job that stopped running. */
export function jobChecks(
  store: BeatStore,
  now: () => number = Date.now,
  jobs: readonly JobSpec[] = REGISTERED_JOBS,
): Record<string, Check> {
  const checks: Record<string, Check> = {};
  for (const spec of jobs) {
    checks[spec.id] = async () =>
      jobStatus(spec, parseBeat(await store.get(beatKey(spec.id))), now());
  }
  return checks;
}
