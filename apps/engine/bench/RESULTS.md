# p99 ingest benchmark results

> Decision: **keep variant B (RLS-on `ingest_event()`), formally reject variant C (explicit
> transaction).** Both acceptance gates pass with wide margin. Run on a
> production-shaped path: a Cloudflare Worker → Hyperdrive (caching off) → Neon Postgres, connecting
> as the non-owner, RLS-enforced `webhook_ingest` role.

## How it was run

- **Worker:** `apps/engine/src/bench/worker.ts` (`wrangler.bench.jsonc`), one `POST /run/:variant`
  per insert, returning the in-Worker DB round-trip (`dbMs`) and total handler time. Deployed to
  `webhook-bench.<acct>.workers.dev` for the window only, then torn down.
- **Origin:** a throwaway always-warm Neon branch (`ws-e-bench`), us-east-2, **fixed 0.25 CU**, pg17.
  Migrations `0001–0010` + `apps/engine/bench/setup.sql` applied; all four variant paths smoke-tested
  green as `webhook_ingest` before the load run.
- **Driver:** `apps/engine/bench/driver.mjs` — warmup → steady (50 rps × 40 s) → burst (100-wide × 6)
  per variant, then a 90 s idle + cold burst for A and B. Aggregates p50/p95/p99/p99.9 of both the
  end-to-end ACK (driver clock) and the DB round-trip (Worker clock).
- **Compute posture:** the branch ran at fixed 0.25 CU with Neon's default autosuspend (~300 s),
  which exceeds the 90 s cold-idle, so the compute stayed warm throughout and the "cold" scenario
  measures **Hyperdrive reconnect**, not Neon compute spin-up — exactly the scenario the acceptance
  gate asks for (always-on ingest is the standing production posture; this models its reconnect tail). Total
  run 278 s; **0 errors** across all variants and scenarios.

## The four variants

| | path | RLS | round-trips | notes |
|---|---|---|---|---|
| **A** | bare `INSERT` into an RLS-**off** copy table (`events_bench`) | none | 1 | measurement-only floor; **never a shippable path** |
| **B** | `SELECT ingest_event(...)` — `SECURITY INVOKER`, `set_config(local)`, `ON CONFLICT` | on | 1 | **the proposed production path** |
| **C** | `BEGIN; set_config(local); INSERT; COMMIT` | on | multiple | explicit transaction (anti-pattern) |
| **D** | `SET app.current_org; INSERT` in one simple-query batch | on | 1 | session-level `SET` |

## Results (ms; p50 / p95 / p99 / p99.9)

### steady — 50 rps × 40 s (~1,900 samples/variant)

| variant | n | err | ACK | DB |
|---|---|---|---|---|
| A | 1815 | 0 | 356.9 / 466.0 / 501.9 / 613.6 | 298.0 / 430.0 / 458.0 / 503.0 |
| **B** | 1900 | 0 | 346.9 / 456.2 / 491.0 / 619.7 | 288.0 / 419.0 / **451.0** / 494.0 |
| C | 1903 | 0 | 839.8 / 922.0 / 980.7 / 1102.3 | 806.0 / 845.0 / 937.0 / 1070.0 |
| D | 1862 | 0 | 161.9 / 239.9 / 252.6 / 336.6 | 134.0 / 139.0 / 195.0 / 263.0 |

### burst — 100-wide × 6 (600 samples/variant)

| variant | n | err | ACK | DB |
|---|---|---|---|---|
| A | 600 | 0 | 355.2 / 614.9 / 714.7 / 827.7 | 282.0 / 515.0 / 608.0 / 632.0 |
| **B** | 600 | 0 | 332.2 / 642.1 / **671.9** / **693.2** | 296.0 / 517.0 / 527.0 / 534.0 |
| C | 600 | 0 | 935.4 / 1604.1 / **2219.5** / 2345.2 | 822.0 / 1515.0 / 2181.0 / 2217.0 |
| D | 600 | 0 | 221.3 / 511.4 / 520.3 / 529.2 | 157.0 / 373.0 / 380.0 / 383.0 |

### cold — 90 s idle, then 50-wide burst (A, B)

| variant | n | err | ACK | DB |
|---|---|---|---|---|
| A | 50 | 0 | 489.1 / 636.7 / 647.3 / 647.3 | 286.0 / 509.0 / 514.0 / 514.0 |
| **B** | 50 | 0 | 367.3 / 556.9 / 559.6 / **559.6** | 302.0 / 526.0 / 532.0 / 532.0 |

## Verdict (acceptance)

1. **Keep B — RLS overhead is negligible.** B's steady DB p99 (451 ms) is **−7 ms** vs the RLS-off
   floor A (458 ms): the per-command RLS policies + the `SECURITY INVOKER` `ingest_event()` call +
   `set_config(local)` cost nothing measurable over a bare insert. (The dominant cost in all numbers
   is the Worker↔Hyperdrive↔us-east-2 network round-trip, not the query.)
2. **Reject C — the explicit transaction is an anti-pattern under Hyperdrive.** Burst ACK p99
   **2219 ms ≈ 3.3× B** (and DB p99 2181 ms): an explicit `BEGIN…COMMIT` pins a pooled upstream
   connection for the life of the transaction, so under 100-wide concurrency the pool saturates and
   requests queue. This is the documented Hyperdrive behavior, now measured.
3. **B clears the tightest provider budget with margin.** B's worst tail — burst p99.9 693 ms, cold
   p99.9 560 ms — sits **~7–9× inside** the Shopify ~5 s delivery-timeout budget.

**No fallback needed:** B did not fail, so the insert-only-role fallback and the double-failure
architecture escalation are not triggered.

## A note on D (faster, but not selected)

D is the fastest variant (steady DB p99 195 ms). It is **not** chosen, on correctness grounds: D sets
the tenant GUC with a **session-level** `SET app.current_org` rather than B's statement-local
`set_config(…, true)`. Under Hyperdrive's transaction-mode pooling the upstream connection is reused
across requests, so a session `SET` can **persist and leak the org context to a later request** that
lands on the same pooled connection — a tenant-isolation defect. B's single-statement, transaction-
local scoping is precisely what prevents that leak. The speed gap is real but is the cost of the
isolation guarantee; B is the right trade. (If D's latency ever matters, the safe way to capture it
is a `RESET`/`set_config(local)` discipline that provably cannot outlive the statement — out of scope
here.)

## Reproducing

```sh
# 1. provision a throwaway always-warm Neon branch; apply migrations 0001..NNNN as webhook_owner,
#    then apps/engine/bench/setup.sql; set the webhook_ingest password.
# 2. wrangler hyperdrive create <name> --connection-string=<ingest-url> --caching-disabled
#    -> put the returned id into wrangler.bench.jsonc's hyperdrive binding.
# 3. wrangler deploy -c wrangler.bench.jsonc
# 4. BENCH_URL=https://webhook-bench.<acct>.workers.dev \
#      STEADY_RPS=50 STEADY_SECS=40 BURST_CONC=100 BURST_ROUNDS=6 COLD_CONC=50 \
#      node apps/engine/bench/driver.mjs > RESULTS.md
# 5. tear down: delete the bench Worker, the Hyperdrive config, and the Neon branch.
```

_The bench Worker, the Hyperdrive config, and `events_bench`/the RLS-off floor exist only for this
measurement and never ship on a production route._

---

# Variant R — R2-inclusive durable-before-ACK (the ADR-0013 gate)

> Decision: **ship PUT-first synchronous durable-before-ACK; the Postgres-staging fallback stays
> unbuilt.** The original A–D run measured only the DB insert; variant **R** adds the durable-before-ACK
> **R2 PUT in front of the variant-B insert** (`payloadR2Key` → `R2.put` → `ingest_event`) so the
> end-to-end ACK budget is measured *with* the R2 PUT — the half WS-E never covered.

## How it was run (2026-06-14)

Same production shape as A–D: a Cloudflare Worker → caching-off Hyperdrive → a throwaway Neon branch
of `webhook-ci` (**us-east-2, pg17**, migrations `0001–0011` + `setup.sql`), connecting as
`webhook_ingest`, plus a throwaway R2 bucket. The Worker reports `r2Ms` (the PUT), `dbMs` (the insert),
and `totalMs` (the handler total) **from inside the isolate**, so the numbers below are the ACK budget
itself — free of the load driver's own network latency. **~2,600 requests, 0 errors.** Branch +
Worker + Hyperdrive torn down after.

## Results (ms; p50 / p95 / p99 / p99.9 — worker-internal `totalMs`, with DB + R2 splits)

| scenario | n | err | total | DB | R2 |
|---|---|---|---|---|---|
| **R** steady 5 KB (40 rps × 25 s) | 916 | 0 | 416 / 533 / 586 / **690** | 248 / 355 / 397 / 437 | 161 / 211 / 279 / 340 |
| **R** burst 5 KB (80-wide × 8) | 640 | 0 | 468 / 713 / 803 / **849** | 265 / 483 / 550 / 566 | 179 / 259 / 323 / 431 |
| **R** burst 64 KB (50-wide × 6) | 300 | 0 | 436 / 646 / 659 / **687** | 258 / 460 / 474 / 482 | 175 / 224 / 249 / 264 |
| **R** burst 256 KB (40-wide × 4) | 160 | 0 | 454 / 680 / 694 / **700** | 262 / 462 / 470 / 480 | 197 / 265 / 330 / 349 |
| B baseline burst (80-wide × 6) | 480 | 0 | 262 / 466 / 477 / **482** | 262 / 466 / 477 / 482 | — |
| **R** cold 5 KB (60 s idle → 50-wide × 2) | 100 | 0 | 619 / 731 / 767 / **1331** | 393 / 461 / 467 / 473 | 199 / 298 / 489 / 1083 |

## Verdict (acceptance — durable-before-ACK)

1. **PUT-first clears Shopify's budget with wide margin.** R's worst sustained-burst total p99.9 is
   **849 ms** and its cold (idle→reconnect) total p99.9 is **1331 ms** — both sit **~3.8–5.9× inside**
   the Shopify ~5 s total budget (and inside the ~1 s connect budget for the steady/burst p50–p99).
2. **The R2 PUT is cheap and size-insensitive.** It adds ~160–430 ms at the tail and barely grows from
   5 KB → 256 KB (R2 stays inside Cloudflare's network — no cross-cloud hop). Vs the B baseline (total
   p99.9 482 ms), the PUT adds ~370 ms at the burst p99.9 — leaving the combined path ~6× inside budget.
3. **No staging fallback needed.** R did not breach the budget, so the Postgres-staging fallback
   (ADR-0013) stays a documented contingency, never code. `Promise.all(PUT, insert)` remains rejected
   (it would reintroduce the unrecoverable crash window for no latency win we need).

So the riskiest assumption in the write path — *the R2-PUT-inclusive ACK clears the budget* — is
**confirmed on the real production-shaped path.** Slice 5 (the `wbhk.my` write path) is unblocked.

## Reproducing the R run

```sh
# Steps 1–3 as above, plus an R2 bucket + the R2 binding (see wrangler.bench.jsonc), then:
BENCH_URL=https://webhook-bench.<acct>.workers.dev BENCH_VARIANTS=R COLD_VARIANTS=R R_SIZE=5120 \
  node apps/engine/bench/driver.mjs
# tear down: wrangler delete; wrangler hyperdrive delete <id>; empty + delete the R2 bucket;
#            delete the Neon branch.
```
