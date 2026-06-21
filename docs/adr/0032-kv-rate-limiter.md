# ADR 0032 — a durable KV fixed-window rate limiter for the issuer's public endpoints

- status: accepted (**A4c-1** — the primitive; **A4c-2** (next) is its first consumer, the device verify
  path; the deploy slice extends it to magic-link / `/token` / `/authorize`).
- date: 2026-06-21
- scope: `apps/auth/src/issuer/rate-limit.ts` (+ tests).
- relates: ADR-0031 (the device flow — A4c-2's verify-path guess-throttle is the first use), ADR-0027 (the
  deferred durable magic-link rate-limiting this can satisfy), `internal/build-plans/
  lane-c-auth-identity-backend.md` §5 (R-RATELIMIT).
- review severity: high (the guess-throttle behind the device user-code).

## context

The issuer's public endpoints are guessable/floodable: the device `user_code` is ~40 bits (RFC 8628 verify
path), and magic-link / `/token` / `/authorize` are public. Better Auth's built-in limiter stores counters
**in memory** — per-isolate on Workers, so it's ineffective fleet-wide (ADR-0027 flagged this as
must-before-live). A4c needs a **durable** guess-throttle on the device verify path before that path is
reachable; the same primitive serves the other deferred rate-limits.

## decision

A **fixed-window counter over KV** (`consumeRateLimit(deps, bucket, rule)`): one KV key per
`(sha256(bucket:windowIndex))`, incremented per attempt, TTL'd to the window (clamped to KV's 60s minimum).
Returns `{ allowed, remaining, retryAfterSeconds, resetSeconds }`. Pure logic over an injected `RateLimitKv`
+ clock, so it's unit-tested and reused by any endpoint. The bucket (an IP / principal) is hashed into the
key so a KV listing never exposes raw inputs.

**Why fixed-window over alternatives:** a Durable Object per principal would be exact but adds a stateful
hop + cost per request; a sliding-window log is more KV ops + complexity. For an **abuse throttle** (not a
hard quota) the fixed-window's known trade-offs are acceptable: (1) a burst at a window boundary can admit
up to ~2× the limit across the seam; (2) KV's non-transactional read-then-write under-counts under heavy
concurrency (admits a few extra). Both fail toward *slightly more* attempts, never fewer, and are bounded.
Edge/WAF-level rate-limiting (network floods) remains a separate, complementary deploy-slice concern — this
is the **application-level** per-principal throttle.

**Failure posture (the caller decides):** a KV error propagates — guess-throttled callers must catch and
**deny** (a KV outage must not open a guessing window). A malformed stored counter fails **open** (treated
as 0), bounded only because the key is hashed and KV is write-protected (no attacker can seed a corrupt
counter).

## consequences — A4c-2 (the device verify consumer) MUST

- **Size the limit for the 2×-burst + concurrency over-admission**, not naively: the enforced ceiling is
  effectively ~`limit + boundary_burst + concurrency_fanout`. Prefer a **low count + short window** (the
  burst scales with the count, not the window). The user-code keyspace defenses (short TTL + single-use,
  ADR-0031) do the heavy lifting; the limiter caps the guess rate on top.
- **Choose buckets that can't be weaponized:** never key solely on a *victim-controlled* value (e.g. a
  target user-code / email) — `consume`-first would let an attacker burn a victim's budget. Key on the
  attacker-controlled dimension (the authenticated session principal + the source IP).
- **Catch + deny on a thrown KV error** (fail-closed at the call site), and emit `Retry-After` from
  `retryAfterSeconds` (and optionally `RateLimit-Reset` from `resetSeconds`).
- Combine with A4c's **authed-session gate** (approval requires a logged-in session, so a guessed code can
  only be approved into the attacker's own org — the limiter then caps how fast they can hunt for a live
  code).

## test posture

Unit-tested (7 tests) against a fake KV with an injected clock: under-limit budgeting, denial + the
retry-after to the window end, window rollover, bucket isolation, the malformed-counter fail-open, the
bucket-hashing, and the **TTL written to `put` (incl. the 60s-minimum clamp** — the case that would
otherwise make a short-window `put` throw on real KV, caught in review). Real-KV behavior (the boundary
burst, the concurrency under-count) is documented, not unit-asserted (a fake can't model KV's eventual
consistency); A4c-2 sizes its params accordingly.
