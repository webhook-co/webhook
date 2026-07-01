# ADR 0087 — delivery reliability: retry schedule, dead-letter, auto-disable, reconciliation, and owner notification

- status: accepted
- date: 2026-07-01
- scope: `packages/db`, `apps/engine`, `apps/auth`, `packages/contract`
- review severity: high (delivery durability + tenant-isolation of the cross-org control-plane roles)

## context

ADR-0081 (remote replay) and ADR-0084 (send-side signing) established that the **engine is the single
outbound egress chokepoint**: it delivers a stored event's bytes to a pre-registered destination, behind the
connect-time SSRF guard, Standard-Webhooks-signed per destination. What those left open is *reliability* — what
happens when a destination is down, stays down, or a delivery is stranded by an infrastructure blip. This ADR
records the reliability model built across S3 Slice 3 (native auto-delivery + the per-destination delivery
Durable Object). The founder-locked shape: **native auto-delivery, a per-destination DO, best-effort-default
ordering (opt-in strict-FIFO), ret/DLQ with auto-disable, cross-org reconciliation, and an owner email on
disable.**

## decision

### 1. Retry schedule + dead-letter (migration 0027)

A failed delivery is rescheduled on **a fixed exponential schedule** (a bounded, growing back-off with a
capped ceiling and a fixed maximum attempt count — the exact curve lives in `packages/db`). A delivery that
exhausts the schedule is **dead-lettered**: `status = 'dead'`, terminal, retained as truthful history (never
silently dropped). Distinct terminal states carry distinct meaning and are never conflated:

- `delivered` — a 2xx from the destination.
- `dead` — retries exhausted (sustained failure).
- `blocked` — an **instant** SSRF refusal (the URL resolved to a private/internal address); NOT a
  "destination is down" signal, so it never counts toward the failure tally (else a transient DNS blip would
  trip the multi-day threshold in minutes).
- `cancelled` — the destination was removed while the delivery was still open (ADR — migration 0031).

### 2. Auto-disable after persistent failure (migrations 0031/0033/0034/0035)

Each destination carries a `consecutive_failures` tally, bumped **only** by a `dead` terminal (not `blocked`,
not a delivered reset). When it crosses a threshold **while the destination is still enabled**, the engine
disables it in a single race-safe statement (`set disabled_at = now() where … and disabled_at is null and
consecutive_failures >= threshold returning …`), so concurrent crossers disable **exactly once**. The disable
finalization is deliberately **decoupled** from the delivery's dead-letter (separate transactions): an
audit/notify failure can never roll back the dead-letter and cause a duplicate re-POST.

On a disable the engine writes, in the same transaction as the disable: a `replay_destination.disabled` audit
row, and a durable `notification_intents` row carrying a **context snapshot** (destination URL, failure count,
last error + status code — migration 0035). The engine cannot send mail (no identity-email read, no mail
binding); the snapshot lets a separate notifier send an informative email **without** reading the destination
URL or the delivery error itself.

### 3. Best-effort-default ordering, opt-in strict-FIFO

Deliveries to a destination are drained by its per-destination Durable Object. Ordering is **best-effort by
default** (throughput-friendly); a destination may opt into **strict-FIFO** (head-of-line barrier), accepting
that a stuck head blocks the queue. This is a per-destination flag (ADR — migration 0031).

### 4. Cross-org reconciliation (migration 0033)

The DO drains all due deliveries on any wake, so an **active** DO self-heals. The gap is an **idle** DO with
stranded work — a lost wake (the delivery row committed but the post-ACK wake fan-out failed) or a re-enabled
destination whose queued rows accrued while it was disabled. An hourly engine cron closes both: it re-wakes
(idempotently) any destination with a due, unclaimed delivery. This read is **cross-org**, so it runs as a
dedicated **`webhook_reconciler`** role — NON-OWNER, NOSUPERUSER, **NOBYPASSRLS**, with role-targeted
`FOR SELECT` policies + column grants scoped to the reconciliation keys only. It reads which DOs to wake and
nothing else; every mutation still happens inside the DO under the tenant `webhook_app` role. A staleness
grace keeps the steady-state set tiny; random ordering under a bounded limit prevents starvation.

### 5. Owner notification on disable (migrations 0034/0035)

A separate cron in the **auth** worker (which holds the mail credential + identity access) drains pending
`notification_intents` → emails the org **owner** → marks each sent. It runs as a dedicated
**`webhook_notifier`** role — NON-OWNER, NOSUPERUSER, NOBYPASSRLS, with role-targeted `FOR SELECT` (pending
intents + membership owner) and `FOR UPDATE` bounded to `status = 'pending'` → `'sent'`, plus a column grant
on `(id, email)` of the global identity table. It never reads the destination URL, the delivery error, or the
owner's name — only the engine's self-contained context snapshot.

**Claim-then-send (at-most-once).** The drain **claims** each intent (the single-flight `pending → sent` flip)
*before* sending, so under two overlapping passes exactly one claims and sends. A send failure after a claim
is logged and **not** retried — the destination is already disabled and visible in the dashboard, so a missed
courtesy email is preferable to the double-send an un-claim/retry would risk. An intent whose org has no
resolvable owner is claimed to clear it (no email), so it can't accumulate in the pending backlog forever.

## consequences

- **Tenant isolation holds by construction.** Both cron roles are cross-org yet NOBYPASSRLS: the RLS-native
  role-targeted-policy pattern (ADR-0004's `webhook_anchor`, ADR-0055's `webhook_sweeper`) means `FORCE ROW
  LEVEL SECURITY` still defeats an owner/`SECURITY DEFINER` bypass, and neither role can read tenant content
  beyond its column grants or write anything outside its narrow mandate.
- **Every failure is truthful + recoverable.** Nothing is dropped: a down destination's events stay captured
  and queued, delivery resumes on re-enable (the reconciler re-wakes the DO), and the owner is told.
- **The email carries specifics without widening the notifier.** The engine snapshots the context at disable
  time; the least-privilege notifier reads only that.
- **Known trade-offs (accepted for v1).** The notification is at-most-once — a Resend outage during the one
  drain that claims an intent loses that email (the in-dashboard disabled state remains the source of truth); a
  future retry/re-open path could make it at-least-once if warranted. The cross-org re-**derive** of events that
  never got their deliveries enqueued at all (a cross-org *write*) is deferred; the reconciler here re-wakes
  destinations that already have queued rows.

## alternatives considered

- **A `BYPASSRLS` cron role.** Rejected — it would defeat tenant isolation for the whole role; the codebase
  forbids it off the owner/migration path.
- **Broadening the notifier to read the destination URL + delivery error directly.** Rejected — it would give
  a mail-sending role read access to routing config + response bodies. The engine-authored context snapshot
  keeps the notifier minimal.
- **Send-then-mark (at-least-once) for the notification.** Rejected as the default — under overlapping drains
  it double-sends every time, not just on failure. Claim-then-send bounds duplicates to zero at the cost of a
  rare miss, which the dashboard covers.
