/**
 * Vendor-neutral service health primitives.
 *
 * The split follows the Kubernetes probe convention, which the engine already half-implements:
 *
 *   - **liveness** (`/healthz`) answers "is this process running" and touches NO dependency. The
 *     existing static `"ok"` handlers are correct liveness probes and are deliberately unchanged.
 *   - **readiness** (`/readyz`) answers "can this serve traffic" and DOES check dependencies. That
 *     is what this module builds, and what was missing everywhere.
 *
 * The document shape follows IETF `draft-inadarei-api-health-check` (`application/health+json`):
 * a `status` of `pass | warn | fail` plus a `checks` map keyed by `componentName:measurementName`.
 * Following the draft rather than inventing a shape means any status vendor, dashboard, or future
 * OpenTelemetry exporter can read it without a bespoke adapter — the health surface is the asset,
 * and the status vendor polling it is swappable.
 *
 * SECURITY. Two response shapes come out of one document, because dependency topology is
 * attack-surface intelligence:
 *   - {@link publicReadyz} is unauthenticated and emits ONLY the overall status.
 *   - {@link authedHealth} requires a bearer token and emits the full check map.
 * Pair the public endpoint with {@link memoized} so request rate is decoupled from dependency load;
 * an unauthenticated endpoint that issues a database query per request is a DoS amplifier.
 */

/** Overall or per-check health, ordered least to most severe. `warn` still serves traffic. */
export type HealthStatus = "pass" | "warn" | "fail";

/**
 * One dependency probe. Resolving (or resolving `"pass"`) means healthy; returning `"warn"` means
 * degraded-but-serving; returning `"fail"` or THROWING means unhealthy. A check never needs its own
 * try/catch — {@link runChecks} converts a throw into `fail`.
 */
export type Check = () => Promise<HealthStatus | void>;

export interface CheckOutcome {
  readonly name: string;
  readonly status: HealthStatus;
  readonly durationMs: number;
}

export interface HealthCheckEntry {
  readonly status: HealthStatus;
  readonly observedValue: number;
  readonly observedUnit: "ms";
  readonly time: string;
}

export interface HealthDocument {
  readonly status: HealthStatus;
  readonly checks: Record<string, readonly HealthCheckEntry[]>;
  readonly releaseId?: string;
}

const SEVERITY: Record<HealthStatus, number> = { pass: 0, warn: 1, fail: 2 };

/**
 * The most severe status in the set. An EMPTY set is `pass`, not `fail`: a service that declares no
 * dependencies is healthy, and defaulting the other way would make every such service permanently
 * red.
 */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  let worst: HealthStatus = "pass";
  for (const s of statuses) if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}

/**
 * Run every check concurrently, each bounded by its own timeout, and never reject.
 *
 * The timeout is the load-bearing part. A dependency that HANGS is the failure mode that turns a
 * naive health check into a hung endpoint — which a prober then records as a timeout rather than a
 * clean 503, and which holds a worker invocation open while it happens.
 */
export async function runChecks(
  checks: Record<string, Check>,
  opts: { timeoutMs?: number } = {},
): Promise<CheckOutcome[]> {
  const timeoutMs = opts.timeoutMs ?? 2_000;

  return Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<CheckOutcome> => {
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const status = await Promise.race<HealthStatus | void>([
          check(),
          new Promise<HealthStatus>((resolve) => {
            timer = setTimeout(() => resolve("fail"), timeoutMs);
          }),
        ]);
        return { name, status: status ?? "pass", durationMs: Date.now() - started };
      } catch {
        // Deliberately swallowed: the error's MESSAGE must never reach a response body, and the
        // only signal a readiness probe needs is that the dependency did not answer.
        return { name, status: "fail", durationMs: Date.now() - started };
      } finally {
        // Guarded rather than passed through: the Workers `clearTimeout` signature takes
        // `number | null`, so an untouched `undefined` timer would not typecheck.
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}

/** Assemble an IETF health document. Overall status is the worst of its parts. */
export function healthDocument(
  outcomes: readonly CheckOutcome[],
  opts: { time: string; releaseId?: string },
): HealthDocument {
  const checks: Record<string, HealthCheckEntry[]> = {};
  for (const o of outcomes) {
    checks[`${o.name}:responseTime`] = [
      { status: o.status, observedValue: o.durationMs, observedUnit: "ms", time: opts.time },
    ];
  }
  return {
    status: worstStatus(outcomes.map((o) => o.status)),
    checks,
    ...(opts.releaseId === undefined ? {} : { releaseId: opts.releaseId }),
  };
}

const HEALTH_HEADERS = {
  "content-type": "application/health+json; charset=utf-8",
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
} as const;

/** `fail` is the only status that stops traffic; `warn` is degraded but still serving. */
const httpStatusFor = (s: HealthStatus) => (s === "fail" ? 503 : 200);

/**
 * The UNAUTHENTICATED readiness response: overall status and nothing else.
 *
 * Status code carries the signal (200 healthy / 503 not), so a prober needs no body parsing at all.
 * The body is deliberately the minimum that is still a valid health document — check names,
 * timings, dependency identities and release ids are all withheld. A test asserts on the exact
 * serialised bytes so that adding a field to {@link HealthDocument} breaks the build instead of
 * quietly widening what this endpoint discloses.
 */
export function publicReadyz(
  doc: HealthDocument,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ status: doc.status }), {
    status: httpStatusFor(doc.status),
    // Callers merge their own transport-security headers (HSTS, referrer-policy) here rather than
    // re-wrapping the Response at five call sites, which is how those headers drift apart. The
    // health headers are applied AFTER, so a caller cannot accidentally make this endpoint
    // cacheable or indexable.
    headers: { ...extraHeaders, ...HEALTH_HEADERS },
  });
}

/**
 * Compare two secrets without leaking a byte-position oracle through timing.
 *
 * Length is compared up front and therefore leaks, which is accepted: token LENGTH is not a
 * meaningful secret, whereas a per-byte early return would let an attacker recover the token
 * one character at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

/**
 * The AUTHENTICATED health response: the full check map, for operators and dashboards.
 *
 * An unauthorised caller gets **404, not 401**. A 401 confirms that something exists at this path,
 * which tells a prober exactly where to aim; a 404 is indistinguishable from the endpoint not being
 * there. An unset token disables the endpoint entirely rather than accepting an empty credential.
 */
export function authedHealth(doc: HealthDocument, request: Request, token: string): Response {
  const notFound = () =>
    new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  if (!token) return notFound();

  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return notFound();
  if (!timingSafeEqual(header.slice(prefix.length), token)) return notFound();

  return new Response(JSON.stringify(doc), {
    status: httpStatusFor(doc.status),
    headers: HEALTH_HEADERS,
  });
}

/**
 * Cache an async result for `ttlMs`, collapsing concurrent calls into one invocation.
 *
 * Both halves matter for a public readiness endpoint. The TTL bounds how often dependencies are
 * touched no matter how often the endpoint is hit; the single-flight behaviour stops a burst of
 * simultaneous probes on a cold cache from becoming a burst of database connections. A REJECTION is
 * never cached — one blip would otherwise pin the service to "unhealthy" for the whole TTL.
 *
 * `now` is injectable so tests can advance the clock without waiting on it.
 */
export function memoized<T>(
  fn: () => Promise<T>,
  ttlMs: number,
  now: () => number = Date.now,
): () => Promise<T> {
  let cachedAt = 0;
  let cached: T | undefined;
  let hasCached = false;
  let inFlight: Promise<T> | undefined;

  return async () => {
    if (hasCached && now() - cachedAt < ttlMs) return cached as T;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const value = await fn();
      cached = value;
      cachedAt = now();
      hasCached = true;
      return value;
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}
