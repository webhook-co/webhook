# ADR 0104 — Configurable per-endpoint deduplication + dedup-path hardening

- status: accepted.
- date: 2026-07-06
- scope: `packages/shared` (the `DedupConfig` schema + bounded field-path grammar), `apps/engine`
  (`deriveDedup` modes, canonical path/query fold, the bounded field-path evaluator, content-addressed
  R2 keys). Later slices extend `packages/db` (persistence + resolver principal + KV validator),
  `packages/contract` + `apps/api`/`apps/mcp`/`packages/cli`/`apps/web` (the `endpoints.update`
  capability + surfaces), and `apps/docs`.
- relates: [0013](0013-ingest-durability-ordering-put-first.md) (durable-before-ACK; the R2 PUT this
  hardens), [0085](0085-accept-all-verbs-get-handshake.md)/[0086] (accept-all-verbs; the GET traffic
  the query-fold affects), [0004](0004-hybrid-flat-alert-first-pricing.md) (single-dimension event
  metering + soft-cap-pause — the billing model dedup interacts with).

## context

Dedup on the ingest path is a DERIVATION recorded per event (`dedup_strategy`), gating a single
`INSERT ... ON CONFLICT (endpoint_id, dedup_key) DO NOTHING`. The fallback key was
`${method}:sha256(body):${24h-bucket}` — the **URL query string was never in the key**, so two
requests differing only by query (the common case: empty-body GETs like `/tok?id=1` vs `/tok?id=2`)
collapsed to one event. The window was a global 24h constant with **no per-endpoint control**.

Two facts, verified in code, frame the design:

1. **Billing counts distinct dedup keys.** `usage.event_count` is `count(*)` over `events`
   (`0004_metering.sql`, `0007_usage_rollup.sql`); a dedup no-op writes no row and is not metered. So
   the dedup key is a **billing-control surface**, and dedup is best-effort load-reduction, NOT an
   exactly-once guarantee (webhooks are at-least-once industry-wide).
2. **The dedup key was attacker-influenceable and named the R2 payload object** (`ingest.ts`
   `payloadR2Key(..., dedupKey)`), and is derived from **unverified** input (dedup precedes verify).
   A forged key-collision could overwrite a legitimate payload (PUT precedes the ON CONFLICT gate).

Prior-art and threat analysis: `internal/research/ingest-deduplication.md`.

## decision

**A per-endpoint `dedup_config` with four modes + a bounded window.** NULL config = the default
(identifier ladder, 24h) so existing endpoints are unchanged except the query-fold (below).

- **`identifier`** (default): the id ladder — `webhook-id` header → provider event id → content-hash
  fallback. The fallback now folds a **canonical path+query** so distinct URLs are distinct events.
- **`content`**: always the canonical content hash (skip the id ladder) — for senders whose ids are
  unreliable or reused across distinct events.
- **`fields`**: key from operator-selected field paths (`headers|body|query|path`, dot + array
  accessors) — for senders with no stable id but a stable payload field.
- **`off`**: a per-request-unique key (every request is a distinct, billable event). Opt-in, warned.

**Canonical path+query fold (a deliberate, announced default change).** Volatile params
(`utm_*`, `_`, `cachebust`, `ts`, `nonce`, `signature`, `sig`, `attempt`) are dropped, the rest are
sorted and uniformly re-encoded, and folded into the content-hash fallback. Only bodyless/identical-body
requests differing by query change behavior; identical requests still collapse within the window. The
id ladder runs first, so signed providers (which carry ids) are unaffected. Billing implication: GET-
with-query traffic on unknown-provider endpoints meters more — bounded by the soft-cap-pause; watched
post-ship.

**The field-path DSL is bounded by construction (security).** The grammar is validated at
**config-write** time (`packages/shared/dedup-config.ts`): bounded roots, ≤8 segments/path, array
index ≤100, ≤16 include + 16 exclude paths, no unbounded constructs. The **ingest-time evaluator**
(`apps/engine/dedup-fields.ts`) adds hard runtime bounds over untrusted payloads: 64 KiB body-size
gate, single depth-capped parse of a copy, ≤4096 traversal steps, ≤256 extracted scalar values,
256-byte value truncation, length-prefixed framing (never re-serialize a subtree — subtree hashing is
as fragile as body hashing across sender re-serialization). Outcomes: a stable key; **degrade to
content-hash** (too big / too many values — bounded, collapses identical); or **fail-safe to unique**
(a missing/unresolvable field → a distinct event). Over-collapse (silently dropping a real event) is
the failure mode we design against, so unresolved fields never share a key.

**Bounded content-hash key (no unbounded key material).** The `identifier`-fallback / `content` key
folds a canonical path+query, but the canonical target is **hashed** into the key (`method:hash(body):
hash(target):bucket`), never inlined — a multi-KB query string can't blow the Postgres unique-index
btree tuple limit and lose the event on insert.

**R2 forged-overwrite hardening — sequenced to its own slice.** The dedup key is attacker-influenceable
and the R2 PUT precedes the ON CONFLICT gate, so keying the object by the dedup key alone lets a forged
same-dedup-key request with a different body overwrite a legit payload (a pre-existing residual). The
fix — key the object on `dedup_key ∥ content_hash` (a forged different-body request then writes a
prunable orphan, not an overwrite; distinct events keep distinct keys so per-event-delete stays safe) —
**also requires every reader (delivery dispatcher, replay) to use the STORED `payloadR2Key` rather than
re-derive it from the dedup key**, and is therefore done as its own slice with that reader change, not
folded into the engine-core slice (where it would break delivery). Tracked in the threat-model residual.

## alternatives rejected

- **Fold query into the key but keep it billing-coupled with no config** — rejected: makes a
  best-effort mechanism financially load-bearing with no operator control.
- **Flip the global default to log-everything** (peer inbound-gateway norm) — rejected: a silent
  behavior + billing change for every existing endpoint; the safe default stays dedup-on.
- **A general JSONPath evaluator** — rejected: unbounded work over untrusted payloads on the metered
  hot path. The bounded grammar + runtime caps above deliver the capability without the DoS surface.

## consequences

- Dedup config is a billing-control surface; `off` is opt-in and disclosed, backstopped by the
  soft-cap-pause. Field/identifier collapse still runs on unverified input (a force-collapse /
  suppression primitive) — tracked in the threat model; `dedup_strategy` is recorded so a collapsed
  event is explainable. Config changes must evict the resolver's KV entry (later slice) or the engine
  serves stale config until TTL; a config change opens a brief dual-key window (documented, not
  exactly-once).
