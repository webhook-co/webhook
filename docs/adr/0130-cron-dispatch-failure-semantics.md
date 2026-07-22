# ADR-0130: cron dispatch failure semantics, and how the fan-out is covered

- **Status:** Accepted
- **Date:** 2026-07-22
- **Relates to:** `apps/engine/src/index.ts` (`scheduled`, `scheduledCronPlan`), `apps/api/src/index.ts`
  (`scheduled`), `apps/auth/src/runtime/scheduled.ts`, `scripts/cap-cron-sync-guard.mjs`,
  `scripts/cron-dispatch-guard.mjs`, ADR-0055 (cross-org expiry sweep)

## Context

Three Workers declare `triggers.crons`: `apps/engine` (15 crons across two triggers), `apps/api` (2) and
`apps/auth` (2). Each fans its jobs out from `scheduled()` via `ctx.waitUntil`. Repo-wide, **no test
invoked any worker's `scheduled()` handler** — only the engine's pure routing helper `scheduledCronPlan`
was covered. Deleting a `ctx.waitUntil(...)` block failed no test: the cron would simply stop running in
production, permanently, with no error to alert on.

While closing that gap we had to settle what the dispatch code actually guarantees. Two claims were
embedded in comments across all three apps, and only one of them turned out to be true.

### What the runtime actually guarantees

`waitUntil` units are isolated from each other **by the runtime**, not by application code. Cloudflare's
Context docs state it directly:

> "Similar to `Promise.allSettled`, even if a promise passed to one `waitUntil` call is rejected, promises
> passed to other `waitUntil()` calls will still continue to execute."

This is visible in workerd: `addWaitUntil` appends to a single `kj::TaskSet`; a failing task is popped
from the list *before* the error handler runs, and `IoContext::taskFailed` records status and logs without
aborting, cancelling, or clearing the set.

So the comment repeated beside nearly every engine cron — *"Independent of the others — one failing must
not sink the rest"* — is **true, but not because of the hand-attached `.catch()`.** The `.catch()` does
something different:

> "The first `ctx.waitUntil` to fail will be observed and recorded as the status in the Cron Trigger Past
> Events table. Otherwise, it will be reported as a success."

Catching every job therefore means the Cron Trigger status reports **success on every run, regardless of
how many jobs failed**. That is a real observability trade-off, not a no-op.

### The retry flag

Letting a failure surface is not free. In workerd, `ScheduledResult` carries `retry` **independently** of
`outcome`, and it defaults to **true** (`io-context.h`: `bool retryScheduled = true`). The capnp contract
leaving the runtime says the result details "whether the run should be retried." The consumer — Cloudflare's
cron dispatcher — is closed-source, so we cannot verify from open source whether it acts on that flag; but
the alarm scheduler, whose consumer *is* open source, runs a real retry loop off the same flag. Assuming
the receiver ignores it would be unsafe.

`controller.noRetry()` sets that flag to false and is orthogonal to `outcome`, so a handler can surface a
failure *and* provably suppress retry — but only if it is called before anything can throw.

## Decision

1. **Isolation is documented as a runtime property, not an application one.** Comments must not credit the
   `.catch()` with isolation. `apps/api`'s claim that "neither cron can throw, so one faulting can't starve
   the other" is deleted: the isolation is the runtime's, and "neither cron can throw" was an unenforced
   assertion.

2. **Each app's failure posture is a deliberate, per-app choice, recorded where it is made.**
   - `apps/engine` catches every cron and logs a named line. Its crons are cursor-resumed bounded drains
     that resume on the next tick, so a per-job log is the actionable signal. **Consequence: the engine's
     Cron Trigger status is always green.** See "Open" below.
   - `apps/api` deliberately does **not** wrap its crons, so a regression reaches the Cron Trigger status.
     Both crons self-guard and return cleanly when billing is unprovisioned.
   - `apps/auth` catches at the dispatch site. This is specific to auth: it never calls
     `controller.noRetry()`, so the retry flag stays true, and a re-invocation would re-run the
     notification drain — which sends owner email. A duplicate email is worse than a logged failure.

3. **The fan-out is covered by two complementary layers**, because neither is sufficient alone.
   - **Runtime.** `apps/engine/test/scheduled-dispatch.test.ts` and `apps/api/src/scheduled-dispatch.test.ts`
     drive the real `scheduled()` handler and assert how many units are dispatched, that the cap tick runs
     only the cap producer, and that failures are absorbed. They must use a **hand-built bare `Env`**, never
     `env` from `cloudflare:test` — the pool builds that from `wrangler.jsonc`, where every Hyperdrive
     binding is present, so the dark-launch guards do not fire and the crons dial a real database.
     **`apps/auth` is the exception**: its `scheduled` lives in the tsconfig-excluded `src/worker.ts`, which
     no test can import, so it is covered at MODULE level (`src/runtime/scheduled.test.ts`) and the one-line
     delegate in `worker.ts` is deliberate residual untested surface, verified only by `deploy:dry`.
   - **Static** (`scripts/cron-dispatch-guard.mjs`) parses the dispatch body with the TypeScript compiler
     API and pins **identity**, which a runtime test cannot: a `waitUntil` promise is opaque, and 9 of the
     15 engine crons are dark no-ops that emit nothing. It asserts the exact set of cron identifiers, a
     `.catch()` on each, and which side of `if (!plan.runsHourly) return;` each sits on.

4. **The guard keys on function identifiers, never on the human name in the log line.** Those two can
   desynchronise, and two engine crons (`runRetentionPruneDrainCron`, `runFreeOrgCapCron`) deliberately
   throw so that their `.catch()` emits an alarm — a mismatched pairing would page the wrong subsystem.

5. **`apps/auth`'s dispatch lives in a type-checked module.** `src/worker.ts` is excluded from tsconfig
   (it imports the gitignored `.open-next` bundle), so logic placed there is neither type-checked nor
   reachable by any test. The hourly-vs-daily gate moved to `src/runtime/scheduled.ts`, leaving `worker.ts`
   a single delegating call.

## Consequences

- Caught by at least one layer, each demonstrated by mutating the source: a deleted cron; a dropped
  `.catch()`; a `.catch()` whose body was **emptied or its message renamed** (the likelier regression, and
  invisible at runtime because 9 of the 15 crons are dark no-ops that emit nothing either way); a cron
  promoted above the cadence gate; a cron wrapped in an unrelated conditional; a cron handed something
  other than `env`; a second early return that short-circuits the crons below it; an unregistered new cron;
  and, for `apps/api`, one cron swapped for a duplicate of the other.
- Adding cron #16 to the engine requires updating `scripts/cron-dispatch-guard.mjs`, which forces an
  explicit decision about its cadence. That friction is the point.
- The engine's 50,000 subrequest ceiling comment in `apps/engine/wrangler.jsonc` no longer claims a precise
  worst case. It previously cited "~9 crons" and the retention prune's 6,000; the crons had grown to 15, and
  the accounting was inconsistent besides — it counted the drains' multi-statement work correctly but treated
  the per-org enumerations (up to 1,000 orgs, each a multi-statement transaction) as one operation per org.
  Replacing one invented number with another would have repeated the mistake, so the comment now names the
  dominant contributors and states plainly that 50,000 is a chosen backstop, not a measured bound.

## Open

**The engine's Cron Trigger status is always green.** Making it honest means calling `controller.noRetry()`
as the first statement and letting a failure surface — mechanically straightforward, and safe with respect
to retry. It is left open because it is an operations decision, not an engineering one: with 15 jobs
sharing one invocation, any single transient failure would redden the whole run, so it is only an
improvement alongside alerting that can act on it (Logpush filtered on `Outcome = exception`, or the
GraphQL Analytics API). The per-cron structured log lines remain the actionable signal until then.

**One cron's outbound fan-out is not bounded by a constant.** In `reconcileStripeTransport`
(`packages/db/src/meter-transport-reconcile.ts`) the driving query carries no `LIMIT`; `deps.limit`
(`DEFAULT_TRANSPORT_LIMIT`) caps only the surfaced *drift list*. The `for (const [orgId, …] of byOrg)` loop
therefore issues one Stripe `listMeterEventSummaries` call per distinct paying org with a settled row in the
window — it scales with the customer base. Combined with the per-org enumerations above, the shared 50,000
ceiling is a function of tenant count rather than of any bound in the code. This was found while re-deriving
the ceiling and is left as a finding rather than fixed here: changing the bound on a billing-reconciliation
query is a metering-correctness change, not a test-coverage one, and belongs in its own lane with its own
review. The failure mode if the ceiling is reached is that whichever `waitUntil` units run last fail — and
because every engine cron swallows into a log line and the Cron Trigger status is always green (above), the
observable symptom is silence.

**Wall-clock truncation is unmodelled.** `finishScheduled` joins the waitUntil set against a 15-minute
limit and **cancels** the losers. A cancelled cron is not a rejection, so its `.catch()` never runs and it
produces *no* log line at all — including the two crons that rely on the catch as their alarm transport.
Nothing currently measures aggregate wall-clock or CPU across the fan-out.
