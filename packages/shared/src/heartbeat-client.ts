import { readSecretBinding } from "./secrets";

/**
 * The reporting half of the dead-man's-switch heartbeat: how a scheduled job tells `apps/health`
 * that it ran.
 *
 * TWO RULES GOVERN EVERYTHING HERE.
 *
 * 1. **Reporting must never break the job.** A cron exists to do work; telling someone about it is
 *    strictly secondary. Every failure path — unconfigured, unreachable, non-2xx, timeout — is
 *    swallowed. The worst outcome of a broken heartbeat is a false alarm on a status page; the worst
 *    outcome of a heartbeat that throws is a real audit anchor that never gets written.
 *
 * 2. **It ships dark.** With no URL or token configured this is a no-op, so the callers can land and
 *    deploy before `apps/health` exists. Setting both variables activates it; unsetting either
 *    switches it off again. Nothing needs redeploying to change that.
 */
export interface HeartbeatEnv {
  /** Base URL of the health Worker, e.g. `https://health.wbhk.my`. Unset ⇒ reporting is off. */
  readonly HEALTH_HEARTBEAT_URL?: string;
  /** Bearer credential the health Worker checks. Unset ⇒ reporting is off. */
  readonly HEARTBEAT_TOKEN?: SecretsStoreSecret | string;
}

/** Bound so a hung health Worker cannot hold a cron's invocation open. */
const REPORT_TIMEOUT_MS = 3_000;

/**
 * Tell the health Worker a job finished. Resolves regardless of outcome — never throws, never
 * rejects.
 */
export async function reportHeartbeat(
  env: HeartbeatEnv,
  jobId: string,
  ok: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    const base = env.HEALTH_HEARTBEAT_URL;
    if (!base || !env.HEARTBEAT_TOKEN) return; // dark until both are provisioned
    const token = await readSecretBinding(env.HEARTBEAT_TOKEN);
    if (!token) return;

    const url = `${base.replace(/\/+$/, "")}/internal/heartbeat/${encodeURIComponent(jobId)}?status=${ok ? "ok" : "fail"}`;
    await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch {
    // Deliberately swallowed — see rule 1. A status page reporting a false alarm is recoverable;
    // a cron that dies because its telemetry failed is not.
  }
}

/**
 * Run a scheduled job, log a failure, and report the outcome — the shape every cron call site wants.
 *
 * The job's own result is discarded and its errors are logged rather than rethrown, matching what
 * the `scheduled()` handlers already did. What changes is that a failure is now also REPORTED, so a
 * job that runs and fails is distinguishable from one that never ran at all.
 */
export async function withHeartbeat(
  env: HeartbeatEnv,
  jobId: string,
  run: () => Promise<unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let ok = true;
  try {
    await run();
  } catch (err: unknown) {
    ok = false;
    console.log(JSON.stringify({ message: `${jobId} cron failed`, error: String(err) }));
  }
  await reportHeartbeat(env, jobId, ok, fetchImpl);
}
