# ADR 0017 — cursor contract: `headCursor` + `caughtUp` + `lag` on the read surface

- status: accepted
- date: 2026-06-19
- scope: `packages/db` (`tailMeta`, the `events.tail`/`events.list` handlers), `packages/contract`
  (the `events.tail`/`events.list` output), `packages/shared` (`LagSchema`, `LISTEN_LAG_CAP`)
- review severity: high (a read-path correctness + tenant-isolation surface)
- amends: ADR-0014 (live-tail tunnel); relates to ADR-0011 (read-capabilities surface), ADR-0008
  (api-key RLS posture)

## context

`events.tail` conflated "the next page" with "the current head": `buildPage` derives `nextCursor` from
the last returned row, so when a tail catches up (no row) it returns `nextCursor: null` —
indistinguishable from "exhausted." A consumer cannot tell "no more pages" from "you are at the head,"
and — because cursors are opaque + HMAC-signed (`packages/shared/src/cursor.ts`) — a client cannot
construct a "from now" / "save my position" cursor at all. The `?since=now` sentinel (ADR-0014
amendment) was a point-fix for the listen tunnel; the principled fix is to make the read response
self-describing on every surface (api / mcp, and the cli that consumes them).

The gapless invariant constrains the shape: delivery is floored at the 5s watermark
(`received_at <= now() - δ`, δ = `WATERMARK_DELTA_MS`), and the keyset orders on
`(date_trunc('milliseconds', received_at), id)` because the opaque cursor carries millisecond
precision while rows are stored at microsecond precision. Any new cursor-producing site must honor both
or it drops/dups at a same-millisecond boundary.

## decision

Add **optional, additive** fields to the read response (no behaviour change for callers that ignore
them; the parity gate is unaffected since it checks binding presence, not field shape):

1. **`headCursor` = the watermark-bounded latest** (`latestTailCursor`), **never raw `MAX(received_at)`.**
   Raw MAX sits *above* the watermark; an in-flight event commits with a lower `received_at`, and an
   **exclusive** resume from a raw-MAX head would silently skip it. `headCursor` is `null` only for a
   stream with no event at/below the watermark (a genuinely empty endpoint), never merely from paging
   to the end. It is the same opaque HMAC cursor (a position, not a capability).
2. **`caughtUp` = `page.nextCursor === null`** — derived inline in the `events.tail` handler. It is a
   forward-tail concept and is **not** surfaced on `events.list` (a newest-first browse, where it would
   invert).
3. **`lag` = `{ backlogCount, headLagMs? }`.** `backlogCount` is the count of unseen events at/below the
   watermark **strictly after** the request's cursor, **capped** at `LISTEN_LAG_CAP` via `limit cap + 1`
   **in SQL** — a returned value of `cap + 1` means "more than the cap" (the consumer renders `<cap>+`),
   so a large backlog never forces an unbounded scan. The COUNT bounds on the **raw** watermark + the
   lower ms-keyset **only — never on the ms-truncated `headCursor`** (an upper bound there would exclude
   a same-millisecond microsecond sibling, undercounting and risking a downstream gap). `headLagMs`
   (now − head, floored at 0) is advisory and optional.
4. **Additive, not collapse.** We keep `nextCursor` exactly as-is (next page; `null` when exhausted) and
   add `headCursor`/`caughtUp`/`lag` as **separate** fields. Collapsing `nextCursor → headCursor` when
   caught up would re-introduce the next-page-vs-head conflation that is the bug. `events.list` carries
   `headCursor` only (a resumable checkpoint), not `caughtUp`/`lag`.
5. **No `events.head` endpoint.** The head is the existing `latestTailCursor` query exposed as a
   response field, not a new primitive.
6. **Parity is structural.** The fields are produced once in the shared `createReadHandlers` seam
   (`packages/db/src/read-handlers.ts`), which `apps/api` and `apps/mcp` both serialize verbatim — so
   the contract lands on both surfaces in one change. All new reads run inside the caller's RLS-scoped
   `withTenant` transaction, **after** the `getEndpoint` NOT_FOUND guard (no cross-org count/head
   oracle).

A new `tailMeta(tx, { endpointId, sinceCursor, cap })` in `packages/db/src/reads.ts` computes
`{ headCursor, backlogCount }` in one tenant transaction, replicating `tailEvents`' window + keyset
verbatim. `LagSchema` + `LISTEN_LAG_CAP` live in `packages/shared` so the read contract and the live
`/listen` tunnel bind one definition.

## consequences

- Stateless readers (`api.`/`mcp.` `events.tail`) can checkpoint "caught up, resume here" without a
  session; the cli gets a correct "from now" seed and a backlog signal for a resume guard.
- `tailMeta` adds two indexed probes (the `LIMIT 1` head + the `limit cap + 1` count) per tail call,
  alongside the page scan. The cost is bounded (both ride `events_tunnel_idx`); fold into the page scan
  only if measurement shows it matters.
- The watermark + keyset predicate was hand-copied across `listEvents`/`tailEvents`/
  `latestTailCursor`/`tailMeta`. **Extracted (slice FU-2)** to three module-private fragment helpers in
  `reads.ts` — `belowWatermark` (the RAW-`received_at` watermark; δ stays un-truncated), `keysetAfter`
  (forward `>`) and `keysetBefore` (newest-first `<`, both `date_trunc('milliseconds', …)` with the
  `::timestamptz`/`::uuid` casts) — so the byte-for-byte ms-on-wire / µs-in-rows invariant is enforced in
  one place rather than by review. `listEndpoints` (`created_at`) and `resolveSince` stay inline (scoping
  the helpers to the `events` keyset avoids identifier injection for the off-table call site).
- **Tunnel (slice B1b, implemented):** the same `{ caughtUp, lag }` is surfaced over the `/listen`
  tunnel as an additive `StatusFrame` in `ServerFrameSchema` — emitted at connect (the initial caughtUp
  + capped lag, from the seeded resume position) and once on the behind→caught-up transition (a
  `wasCaughtUp` latch, reset on connect and un-latched by any not-caught-up poll, prevents per-poll
  spam). `caughtUp` is the `drainPages` exit reason (a page returned a null nextCursor — NOT the item
  count). `headCursor` stays HTTP-only (a streaming client tracks position from the event-frame
  cursors). The connect-time backlog probe is ADVISORY — wrapped in try/catch so a DB hiccup never
  fails the WebSocket upgrade (mirrors the poll's fail-safe posture) — and runs on the cache-disabled
  `HYPERDRIVE_TENANT` binding under the bound org's RLS (no cross-org cached count). An unknown server
  frame is additive-safe: `parseServerFrame` returns null and a consumer skips it (the CLI skips the
  `status` frame until the resume banner renders it).
- **Follow-on (slice B2):** server-side `--since` resolution reuses the same watermark + ms-keyset and
  the same "synthetic `(ms, all-zero-uuid)` boundary" discipline.
