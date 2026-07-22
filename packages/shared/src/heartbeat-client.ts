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

    // Built with the URL constructor rather than by trimming and concatenating strings. A regex
    // trailing-slash trim (`/\/+$/`) is a polynomial-ReDoS pattern on operator-supplied input, and
    // the constructor resolves an absolute path against the base correctly anyway — including a base
    // with stray trailing slashes. A malformed base throws here and is caught below, so a mistyped
    // variable disables reporting instead of reaching an unintended host.
    const target = new URL(`/internal/heartbeat/${encodeURIComponent(jobId)}`, base);
    // https only, and never follow a redirect: the bearer credential must not be replayed to a host
    // the operator did not configure, whether via a mistyped var or a hijacked redirect.
    if (target.protocol !== "https:") return;
    target.searchParams.set("status", ok ? "ok" : "fail");
    await fetchImpl(target.toString(), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch {
    // Deliberately swallowed — see rule 1. A status page reporting a false alarm is recoverable;
    // a cron that dies because its telemetry failed is not.
  }
}

/** Options for {@link withHeartbeat}. */
export interface HeartbeatOptions {
  /**
   * Decide whether a completed run counts as a success.
   *
   * Defaults to "anything but `null`", which is not arbitrary: several crons in this repo catch
   * their own errors and signal failure by RETURNING NULL rather than rejecting — an explicit,
   * documented contract (see `runNotificationDrain`, `runAuthExpirySweep`, both of which promise the
   * scheduled handler will never reject). If a throw were the only recognised failure, those jobs
   * would report healthy while broken, which is the exact false-healthy signal this whole mechanism
   * exists to prevent.
   */
  readonly succeeded?: (result: unknown) => boolean;
  readonly fetchImpl?: typeof fetch;
}

/** A job that returns `null` failed; `undefined`/void and any other value succeeded. */
const notNull = (result: unknown): boolean => result !== null;

/**
 * Run a scheduled job, log a failure, and report the outcome — the shape every cron call site wants.
 *
 * A failure is recognised BOTH from a throw and from a failure-signalling return value, so "ran and
 * failed" is distinguishable from "never ran" for every job regardless of which convention it uses.
 */
export async function withHeartbeat(
  env: HeartbeatEnv,
  jobId: string,
  run: () => Promise<unknown>,
  opts: HeartbeatOptions = {},
): Promise<void> {
  const succeeded = opts.succeeded ?? notNull;
  // Assigned on every path below, so no initialiser: a default here would be dead and would hide a
  // future branch that forgot to set it.
  let ok: boolean;
  try {
    const result = await run();
    ok = succeeded(result);
    if (!ok) {
      console.log(JSON.stringify({ message: `${jobId} cron reported failure` }));
    }
  } catch (err: unknown) {
    ok = false;
    // The error's NAME, never its message. The frames that can reach here include client
    // construction, whose live argument is a Hyperdrive connection string embedding a role
    // credential — so a raw message would make non-leakage depend on an upstream library's error
    // formatting, which nothing in this repo pins. This helper is the intended shape for every
    // future cron call site, so scrubbing belongs here rather than at each of them. (no-secrets)
    console.log(
      JSON.stringify({
        message: `${jobId} cron failed`,
        error: err instanceof Error ? err.name : typeof err,
      }),
    );
  }
  await reportHeartbeat(env, jobId, ok, opts.fetchImpl);
}
