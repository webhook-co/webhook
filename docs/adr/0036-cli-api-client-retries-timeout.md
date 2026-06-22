# ADR 0036 — CLI api-client bounded retries + per-request timeout (the hygiene-tier retry logic)

- status: accepted (**D1a** — the retry/timeout LOGIC of the CLI hygiene tier; the actionable error COPY,
  "did you mean", help-examples, and the `-v/--debug` toggle land in D1b/D2).
- date: 2026-06-22
- scope: `packages/cli/src/retry.ts` (new — shared backoff/sleep + the api retry primitives, extracted
  from `commands/listen.ts`), `packages/cli/src/api-client.ts` (per-request timeout + bounded retries),
  `packages/cli/src/commands/listen.ts` (now imports the shared helpers). Tests: `src/retry.test.ts`
  (new), `src/api-client.test.ts` (+ retries/timeout), `src/commands/listen.test.ts` (the backoff block
  moved into `retry.test.ts`).
- relates: ADR-0009 (CLI foundation), ADR-0014 (the live-tail tunnel whose reconnect backoff this
  generalises), `internal/build-plans/lane-d-cli.md` §D1 + `internal/build-plans/auth-foundation-and-cli-plan.md`
  §4.6 (the hygiene tier). Lane D (`packages/cli`).
- review severity: medium (changes the network behaviour of every CLI read; one fresh-eyes code review +
  one security red-team folded — both clean, no findings).

## context

The CLI's REST client made a single `fetch` with no timeout and no retry: a transient throttle (`429`),
a gateway blip (`502`/`503`/`504`), or a slow/hung server failed the command immediately (a `429` exited
`14` on the first try). Meanwhile the `listen` tunnel already had a capped-exponential, full-jitter
reconnect backoff (`backoffMs`) + an abort-aware sleep (`abortableSleep`) — duplicated, listen-local
logic. The hygiene tier (build plan §4.6) calls for bounded retries + per-request timeouts; this ADR is
the retry LOGIC half (D1a), deliberately split from the user-facing error COPY (D1b) so the logic is
self-mergeable.

## decision

1. **Extract a shared `retry.ts`.** `backoffMs` (generalised with optional `base`/`cap`) + `abortableSleep`
   move out of `listen.ts` into `packages/cli/src/retry.ts`, alongside the api retry primitives:
   `apiBackoffMs` (a shorter `API_RETRY_CAP_MS` so a read never waits the 30s tunnel ceiling),
   `isRetryableStatus`, `parseRetryAfter`, and the `API_*` / `RETRY_AFTER_CAP_MS` constants. `listen.ts`
   imports them — behaviour-identical (the moved functions are byte-for-byte, re-defaulted to the same
   tunnel `base`/`cap`).

2. **Bounded, idempotent-gated, jittered retries.** Each request gets up to `API_MAX_ATTEMPTS` (3 = 1 + 2
   retries) on a **transient** failure — a transport/timeout error or a `{429,502,503,504}` status — with
   capped-exponential full-jitter backoff. A delta-seconds `Retry-After` on a throttle is honoured
   (clamped to `RETRY_AFTER_CAP_MS` = 60 s) in preference to backoff. **Retries are gated to IDEMPOTENT
   requests only**: `request()` takes `idempotent` as a *required* field, so a GET, the idempotency-keyed
   replay POST, and the read-only `auditVerify` POST opt in explicitly, and any future non-idempotent POST
   is a no-retry by construction (a compile error if it omits the flag). A `4xx` other than `429` is
   terminal; the exhausted-retry path surfaces the original capability exit code unchanged.

3. **Per-request timeout.** Each attempt carries a fresh `AbortSignal.timeout(API_TIMEOUT_MS)` (30 s,
   injectable for tests). A fired timeout is caught and treated as a retryable transport failure, so a
   hung/slow-loris server cannot hang the CLI; the worst-case total across the budget is finite and
   bounded.

## consequences

- A transient blip self-heals instead of failing the command; a persistent failure still surfaces the
  same capability exit code (e.g. `429` → `RATE_LIMITED` after exhausting attempts).
- The server's replay idempotency (`on conflict (org_id, idempotency_key) … do nothing`) is the backstop
  for the lost-ACK case, so a retried replay records exactly once — no double side-effect is reachable.
- The error COPY is unchanged here (still the existing messages); the actionable "next command" rewrite
  and `-v/--debug` are D1b/D2.
- `retry.ts` becomes the single resilience module both the tunnel reconnect and the api-client share.

## alternatives considered

- **Retry every method.** Rejected — a blind retry of a non-idempotent POST risks a double side-effect;
  the required `idempotent` flag is safer and future-proof.
- **No explicit timeout (rely on the undici/OS default).** Rejected — a per-attempt budget bounds a
  slow-loris and makes the worst-case deterministic.
- **A retry library (e.g. `p-retry`).** Rejected — a ~20-line pure module avoids a dependency, stays
  injectable for node-tests, and shares the existing jitter with the tunnel.
