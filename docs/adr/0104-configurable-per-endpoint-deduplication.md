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

> **Superseded in part (2026-07-07), see [§ default reversal](#default-reversal-2026-07-07).** The
> original decision made NULL config resolve to `identifier`+24h ("dedup on by default"). That default
> is now **`off` / log every request** — dedup is strictly opt-in. Everything else here stands.

**A per-endpoint `dedup_config` with four modes + a bounded window.** ~~NULL config = the default
(identifier ladder, 24h)~~ **NULL config = `off`** (log every request); the query-fold below applies
only when an operator opts into `identifier`/`content`.

- **`identifier`**: the id ladder — `webhook-id` header → provider event id → content-hash
  fallback. The fallback folds a **canonical path+query** so distinct URLs are distinct events.
- **`content`**: always the canonical content hash (skip the id ladder) — for senders whose ids are
  unreliable or reused across distinct events.
- **`fields`**: key from operator-selected field paths (`headers|body|query|path`, dot + array
  accessors) — for senders with no stable id but a stable payload field.
- **`off`** (default): a per-request-unique key (every request is a distinct, billable event).

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

**R2 forged-overwrite hardening — SHIPPED (Slice 5).** The dedup key is attacker-influenceable and the
R2 PUT precedes the ON CONFLICT gate, so keying the object by the dedup key alone let a forged
same-dedup-key request with a different body overwrite a legit payload (a pre-existing residual). Fixed
by keying the object on `endpoint ∥ dedup_key ∥ content_hash` (`payloadR2Key(org, endpoint, dedupKey,
contentHash)`): a forged different-body request now hashes to a *different* object — a prunable orphan,
not an overwrite — while a genuine retry (same key AND same body) still coalesces, and distinct events
keep distinct keys so per-event-delete retention stays safe even for byte-identical bodies. Because the
key now depends on `content_hash` (which a reader can't recompute without the body it's trying to fetch),
**every engine reader (delivery dispatcher, remote + web replay) now resolves the STORED `payload_r2_key`
from the event row instead of re-deriving it**, fenced by `readPayloadKey(org, endpoint, storedKey)`,
which requires the key to live under the authenticated endpoint's own prefix and match the opaque
sha256-hex object-name shape — a poisoned or cross-tenant key fails closed (a recorded `failed`, never a
read). This preserves the original "never trust a handed key" (H1) guarantee without re-derivation.

## alternatives rejected

- **Fold query into the key but keep it billing-coupled with no config** — rejected: makes a
  best-effort mechanism financially load-bearing with no operator control.
- ~~**Flip the global default to log-everything** (peer inbound-gateway norm) — rejected: a silent
  behavior + billing change for every existing endpoint; the safe default stays dedup-on.~~
  **Reversed 2026-07-07 — see [§ default reversal](#default-reversal-2026-07-07).** This is now the
  chosen default.
- **A general JSONPath evaluator** — rejected: unbounded work over untrusted payloads on the metered
  hot path. The bounded grammar + runtime caps above deliver the capability without the DoS surface.

## consequences

- Dedup config is a billing-control surface; `off` is opt-in and disclosed, backstopped by the
  soft-cap-pause. Field/identifier collapse still runs on unverified input (a force-collapse /
  suppression primitive) — tracked in the threat model; `dedup_strategy` is recorded so a collapsed
  event is explainable. Config changes must evict the resolver's KV entry (later slice) or the engine
  serves stale config until TTL; a config change opens a brief dual-key window (documented, not
  exactly-once).
- **Unverified-input collapse — accepted residual, annotated (Slice 5).** The dedup key is derived
  before signature verification (verify needs the durable body first), so for a signed endpoint an
  attacker who can guess a future event's identifier/selected-field values could pre-send a request
  that collapses (suppresses) the real event as a duplicate. This is inherent to at-least-once dedup on
  unverified input and cannot be closed without gating collapse on a verified key, which would break
  capture-is-the-floor (an unverifiable-but-legit event must still be stored). We accept it and make it
  **explainable**: every event records its `dedup_strategy` and `verified` state, so a "missing"
  (collapsed) event is diagnosable, and operators who need stronger guarantees prefer a `fields` key
  over verified fields or `off`. Documented as a standing threat-model entry, not silently dropped.
- **Metering-delta watch (Slice 5).** The default now folds canonical path+query into the fallback
  content hash, so endpoints that previously collapsed distinct-query GETs into one event will meter
  more events. This is the intended fix (distinct query → distinct event), but it is a billing-visible
  change: watch `usage.event_count` on high-GET endpoints after rollout for an unexpected step-up
  (a sender hammering cache-busting query params would previously have shown as one event/day and now
  shows as many). The volatile-param denylist (`_`, `cachebust`, `cache_bust`) absorbs the common
  cache-buster patterns; extend it if a real sender surfaces a new one.
- **Rolling-deploy compatibility (Slice 5).** The Slice-5 hardening changed the `DELIVERY_DISPATCHER`
  RPC contract (`DeliverArgs.dedupKey` → `payloadR2Key`) AND the `payloadR2Key(...)` key formula, and
  the api/web/engine Workers deploy on independent CDs — so a brief multi-Worker skew is unavoidable.
  It is handled by construction, not by deploy ordering: `readPayloadKey` validates its input as
  `unknown` and **fails closed** on a missing/non-string value, so a previous-release caller that omits
  `payloadR2Key` yields a *retryable* `failed` (never a thrown `undefined.startsWith` / 500), and the
  engine reading the STORED key (not re-deriving) means existing objects — written under the old 3-arg
  key — still resolve by their persisted key regardless of the formula change. In-flight replays during
  the ~1–2 min window may record a retryable `failed` and self-heal on the next attempt; no crash, no
  misdelivery, no data loss.
- **Orphan lifecycle (Slice 5).** Content-addressing means a forged different-body request under a known
  `dedup_key` writes a NEW (unreferenced, unmetered) R2 object instead of overwriting the legit one — a
  storage-amplification tradeoff we take deliberately: it converts main's *forged-overwrite corruption*
  (a real integrity break) into *prunable orphans* (a cost line, not the billable events dimension).
  Orphans are unreferenced by any event row and are reclaimed by the per-prefix retention/reconcile
  sweep; the amplification is bounded by the ingest rate-limit + soft-cap and requires the attacker to
  already hold the endpoint's bearer URL.
- **Stored-key trust boundary (Slice 5).** Delivery/replay now trust the `payload_r2_key` column
  (fenced to the endpoint prefix + sha256-hex shape) instead of re-deriving from the dedup basis. The
  column is written only at ingest, in the same atomic `ingest_event` insert as the row, from a
  server-computed key under RLS — there is no partial-write or user-write path that could point it at
  another intra-endpoint object. The fence catches cross-tenant/malformed keys; a future content-hash
  post-read check could additionally bind the read to the event's own body if a mis-population path ever
  emerges, but none exists today.

## default reversal (2026-07-07)

**Decision: the default (NULL `dedup_config`) is now `off` / log every request. Deduplication is
strictly opt-in.** This supersedes the original "dedup on by default" (identifier+24h) above and the
matching rejected alternative.

**Why the reversal.** webhook.co's wedge is an **inspection** tool — "receive, inspect, replay". The
honest default for an inspection surface is to show a developer *exactly* what a sender sent, retries
and all, not to silently collapse requests behind their back. The original default optimized for a
delivery-pipeline mental model (collapse provider retries) that doesn't match how the product is first
used (watching raw traffic land). Concretely, a founder created an endpoint expecting every request to
appear live and was surprised when identical GETs collapsed — the default was doing something the user
didn't ask for. Opt-in dedup (turn on a mode when retries get noisy) removes the surprise.

**This also aligns the default with the constitution's stated billable unit** — "every captured
request to an endpoint" — rather than "every distinct dedup key". Metering stays `count(*)` over
`events`; with default-off, that count equals captured requests, which is exactly what the pricing page
discloses.

**Billing consequence (accepted, disclosed).** Default-off means **every** captured request — including
sender retries and any non-webhook traffic (uptime checks, link previews) — is a distinct, billable
event. For an existing NULL-config endpoint that was silently relying on the identifier default to
collapse retries, this is a **behavior + billing increase**. It is bounded by the **soft-cap-pause**
(ingestion pauses, it doesn't surprise-bill), disclosed in the docs `off`/default warning, and an
operator who wants collapsing turns on a mode. No hidden counters, single-dimension metering intact.

**No migration / no data change.** The reversal is purely in the resolver default: `defaultDedupParams()`
returns `{ mode: "off" }`, and the single ingest fallback now always routes NULL through
`resolveDedupParams(null)`. Existing rows and existing explicit configs are untouched; only NULL-config
endpoints change behavior, from the next captured request forward.

**Schema honesty (paired change).** `DedupConfigSchema` no longer requires `windowSeconds` for `off`
(it never used one), matching the docs — so a windowless `off` from the SDK/API/docs round-trips
instead of failing validation and being null-dropped. OpenAPI + SDK goldens regenerated.
