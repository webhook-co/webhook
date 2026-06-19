# ADR 0018 — `--since` server-side resolution (synthetic-boundary cursors, no migration)

- status: accepted
- date: 2026-06-19
- scope: `packages/shared` (`parseSince`), `packages/db` (`resolveSince`, the `events.tail` handler),
  `packages/contract` (the `events.tail` input), `apps/api` (the `?since=` route param)
- review severity: high (time→position resolution; a wrong clamp silently skips or replays events)
- relates to: ADR-0017 (cursor contract), ADR-0014 (live-tail tunnel + the `?since=now` sentinel)

## context

Clients cannot construct the opaque, HMAC-signed cursor, so "tail from now / from 2h ago / from a
timestamp" must be resolved **server-side**. The `?since=now` sentinel (ADR-0014) is a point-fix for the
tunnel; this generalises it into a real `--since` grammar on the read surface, reachable from `api.` and
(via the shared capability input) `mcp.`

The gapless invariant constrains it: delivery is floored at the 5s watermark (`received_at <= now()-δ`),
the keyset orders on `(date_trunc('milliseconds', received_at), id)` (the cursor carries millisecond
precision; rows are microsecond). A naive "find the latest event with `received_at < T` then resume
exclusive of it" lookup has two hazards: it is a new table query whose plan (the keyset compares on a
`date_trunc` **expression**, not the raw indexed column) was unverified, and — worse — resolving to a
**real predecessor row** can skip a same-millisecond sibling with a higher id (a silent gap).

## decision

**1. A pure, total grammar parser `parseSince` (in `packages/shared`).** `now` | `beginning` |
`<duration>` (`\d{1,9}` then `s|m|h|d`) | `<RFC3339>`. It NEVER throws — every input returns a tagged
result (`invalid` included), which the handler maps to a typed `VALIDATION_ERROR` and the CLI can
pre-validate identically. RFC3339 is parsed **strictly**: a zone designator is **required** (a no-zone
string silently localises) and the calendar is **range-checked** (a bare `new Date` rolls a `…-31`
overflow into the next month). Never add a `--latest` value (overloaded elsewhere).

**2. Resolution via a SYNTHETIC BOUNDARY cursor — no time→cursor table lookup, hence no migration.**
`resolveSince(tx, since)` resolves a timestamp `T` to the constructed cursor
`(date_trunc('milliseconds', T), <all-zero UUID>)` and lets the **existing** `tailEvents` keyset do the
rest. Because the all-zero UUID sorts below every UUIDv7, the exclusive `>` keyset includes **every**
real event at `ms(T)` (no same-millisecond skip — the silent-gap hazard of resolving to a real row), and
the **Kinesis total function emerges for free** from the keyset + the watermark:

- `<RFC3339>` / `<duration>` with T **before the earliest** retained event → the boundary sorts below
  all rows → tail yields everything (= `beginning`, the Postgres "whichever is greater" clamp).
- T **in the future** or past the watermark → the boundary sorts above all visible rows → tail yields
  nothing (= resume live). Never null, never an error.
- `now` → the actual **watermark head** (`latestTailCursor`): exclusive of it skips the ENTIRE backlog,
  including a same-millisecond backlog event a synthetic watermark-ms boundary would re-surface. It is
  gapless for live tailing (future events get monotonic UUIDv7 ids > head) and matches the existing
  `?since=now` sentinel. This is the **one** mode that resolves to a real row; the others stay
  pure/synthetic. (The R5 "synthetic-only" note's decoupled-id concern does not arise for live now-seeding.)
- `beginning` → **no cursor** (oldest-inclusive). `<duration>`/`now` resolve against the **DB clock**
  (`now()`, skew-safe like the watermark) via a single scalar query; `<RFC3339>` uses the parsed
  millisecond-precision instant directly (no query).

Resolve **once at start**, then iterate by opaque cursor (no per-call re-resolution → no clock-skew /
boundary-dup). **Consequence: there is NO new table-scanning query** — the only scan is the already
index-backed `tailEvents` — so **no migration / no new index is needed.** (This supersedes the planned
"EXPLAIN-first" gate, which was hedging the rejected real-row-lookup design.)

**3. `since` and `sinceCursor` are mutually exclusive** — a caller passes one or neither (mirrors the
engine `/listen` exclusivity). Enforced imperatively in the handler (a typed `VALIDATION_ERROR`),
avoiding a zod-version-fragile `.refine` on the capability input. The synthetic cursor is **server
internal** (it seeds `tailEvents`; it is never signed/returned), so it never bypasses the HMAC
verification path that client-supplied cursors go through.

**4. `from-last-ack` is NOT a server `--since` value** — it is CLI-resolved (the CLI replays its
persisted opaque cursor as `?sinceCursor=`). **This supersedes the canonical plan §4.2 + the
starter-prompt B2**, which list `from-last-ack` as a server-side mode; follow-up: amend canonical §4.2.

The handler resolves `--since` **after** the `getEndpoint` NOT_FOUND guard, in the same RLS-scoped tx
(no cross-org liveness oracle). MCP gets `since` for free via `inputShape` (no `apps/mcp` edit).

## consequences

- Server-side `--since` lands on the pull surface (`api.` + `mcp.`) with total-function semantics and no
  schema change. The same-millisecond-no-skip property is proven against real Postgres + RLS in the db
  pool (the `resolveSince` clamp matrix).
- **Follow-on (engine tunnel):** the `/listen` upgrade still uses the `?since=now` sentinel; generalising
  it to the full `?since=<grammar>` (resolve in the upgrade handler → the existing signed-cursor header,
  no DO change) is a focused follow-on, sequenced after B1b's tunnel work rather than re-touching
  `listen-session.ts` in the same slice.
- The `safe-regex` lint on the RFC3339 pattern is a conservative false positive (anchored `^…$`, only
  bounded quantifiers, star-height 1 → linear, not ReDoS-able); suppressed with a justification inline.
