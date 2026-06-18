# ADR 0014 — live-tail tunnel: a poll-only hibernatable Durable Object on wbhk.my

- status: accepted
- date: 2026-06-16
- scope: `apps/engine` (the `LISTEN_SESSION` DO + the `/listen` upgrade), `packages/db` (the `tailEvents` watermark), `docs/threat-model.md`
- review severity: high

## context

Slice 11 builds the live tail — watching webhook events arrive in real time. 11a shipped the
cursor-pull `events.tail` read on api + mcp (ADR-0011). 11b builds the live transport: a per-session
WebSocket tunnel a developer connects to with `wbhk listen` (11c). It is the engine's first Durable
Object, first WebSocket, and first hibernation/alarm use.

The canonical build plan (internal `wedge-spine-plan.md` §0.10) specified the tunnel as **live push +
resume-from-cursor**: ingest, after ACK, does a best-effort `waitUntil` fan-out that RPC-wakes the
session DO; the DO keeps **no timer** ("the DO never polls on a timer", "no server alarms in the
wedge"), relying on the push to wake it and on hibernation for ~$0 idle cost. That design is
cost-motivated.

This slice re-opened the mechanism under a different priority — **reliability / security / scalability,
cost not a constraint** — with web-grounded and adversarial review. Three findings changed the
calculus:

1. The push is *best-effort*. With no timer, a connected-but-idle client whose wake is dropped (or
   whose reconnect lands with no subsequent write to trigger a push) silently stalls — the classic
   "the notification is the truth" anti-pattern. Robust systems (and the durable webhook-relay / live-
   tail tools we surveyed) treat the notification as a hint and an authoritative query/cursor as the
   truth.
2. The push requires an **active-session registry** + an ingest→DO RPC, coupling the *stateless ingest
   path* (a constitutional non-negotiable: "no Durable Object on ingest") to the tunnel and adding a
   poisonable, cross-tenant-sensitive surface.
3. A verified correction: a *pending* DO alarm does **not** prevent hibernation — only an *executing*
   `alarm()` handler does, while it runs. So an alarm backstop composes with the Hibernation API,
   removing the reason §0.10 forbade timers.

Relates to ADR-0011 (the shared read surface + `events.tail` + parity), ADR-0005 (the
`{kind:"localhost-tunnel", sessionId}` replay target), ADR-0012 (the CLI bearer model), ADR-0002
(Hyperdrive caching off for tenant reads), and `docs/threat-model.md`.

## decision

1. **Single-lane, poll-only delivery at the watermark — no push, no registry, no ingest change.** The
   DO delivers events ONLY at/below the gapless watermark (`received_at <= now() − δ`, δ = 5s) on a
   deterministic alarm poll (`POLL_INTERVAL_MS = 2_000`, tunable). The watermark + opaque cursor are
   the source of truth; the alarm only decides *when* to scan. The first scan runs **inline on
   connect** (immediate backlog flush); the recurring alarm is scheduled one interval out (a `now()`
   alarm is immediately due and auto-fires, racing the connect/idle bookkeeping). This **supersedes
   §0.10's push design** for the wedge: the push's only edge (sub-second delivery of
   newer-than-watermark rows) needs a dual live/durable cursor seam that invites dup-storm /
   off-by-one / gap bugs on reconnect, while costing the ingest coupling + registry above — and with
   the watermark flooring latency at ~5s either way and cost off the table, the simpler single lane is
   strictly more robust and secure.

2. **2s cadence.** Each session polls every 2s ⇒ ~N/2 QPS for N concurrent sessions (vs N at 1s) for
   ~1s of extra worst-case latency that is imperceptible against the 5s watermark floor. Worst-case
   end-to-end ≈ δ + interval ≈ 7s (avg ≈ 6s); polling faster than δ is wasted precision. Realistic
   concurrent-`listen` counts are modest (interactive debugging, not a per-event firehose), and the
   tunnel reads on the dedicated `HYPERDRIVE_TENANT` binding — separate from ingest's `HYPERDRIVE_INGEST`
   pool — so polling cannot starve the write path.

3. **Per-session hibernatable DO, keyed by a server-minted sessionId.** One DO per `wbhk listen`
   session via `LISTEN_SESSION.idFromName(sessionId)`. The session id is the **replay target** of
   ADR-0005 (`{kind:"localhost-tunnel", sessionId}`), so per-session (not per-endpoint) is
   load-bearing; per-endpoint would also collide concurrent listeners. A client reconnects by passing
   `?sessionId=` to resume on the same DO. Uses the WebSocket **Hibernation API**
   (`ctx.acceptWebSocket`, NOT `server.accept()`) + `setWebSocketAutoResponse` ping/pong (answered
   without waking the DO) so the socket survives eviction.

4. **Bearer auth on wbhk.my — a second auth mode on the cookieless apex.** The upgrade reuses the
   api-key bearer chain (ADR-0012) and requires the `events:read` scope, verified against audience
   `https://api.webhook.co`: the tunnel is the `events.tail` capability over a WebSocket transport
   (ADR-0011 — "a transport optimization over the same cursor semantics"), not a distinct resource, so
   existing api keys tunnel unchanged and there is no privilege escalation (same scope, same data the
   REST surface serves). The credential rides the **Authorization header** — never a `?token=` query
   param, which would leak into wbhk.my request logs. Bearer auth is cookieless, so it preserves
   wbhk.my's structural CSRF isolation; it sits alongside the unauthenticated path-token ingest
   routing, not replacing it. The bearer-derived `orgId` (+ endpointId, sessionId) is forwarded to the
   DO on trusted `X-Listen-*` headers that overwrite any client-supplied ones; the DO never reads
   org/endpoint from a client frame.

5. **At-least-once, summaries-only, ack-driven durable cursor.** Frames carry `EventSummary` + an
   opaque cursor, never payload bodies (tiny frames, no R2 I/O in the DO). The DURABLE resume cursor
   advances only on `ack`; the in-memory "streamed this session" position is reset on every connect, so
   a reconnect re-delivers anything un-acked even when the DO is still resident. Consumers dedup by
   cursor/id. Because delivery is single-lane at the watermark, the delivered cursor and the durable
   resume cursor are the same — no live-vs-durable seam.

6. **The alarm must never throw (fail-safe liveness).** A thrown `alarm()` stops retrying after ~6
   attempts and the tail goes permanently silent. The poll runs in try/catch: a poll failure becomes a
   recoverable `POLL_DEGRADED` notice + an unconditional re-arm, never an escaping error.

7. **The watermark is computed Postgres-side.** `received_at` is stamped by the events trigger with the
   DB clock, so the cutoff `now() − δ` is evaluated in SQL (not from a Worker-supplied `Date`) — δ
   stays exactly the ingest `statement_timeout` with no Worker↔Postgres clock skew eroding the gapless
   margin. `WATERMARK_DELTA_MS` stays coupled to `INGEST_STATEMENT_TIMEOUT_MS`. (This also hardened
   11a's shared `tailEvents`, used by api + mcp.)

## consequences

- The tunnel is fully decoupled from the shipped ingest path: no registry, no ingest→DO RPC, so the
  "no DO on ingest" non-negotiable holds strictly. The DO does no outbound I/O (no SSRF surface) and
  only ever reads its bound org under RLS.
- Liveness is deterministic (a poll, not a best-effort push) and fail-safe (never silently dead). The
  cost is ~6s typical latency — acceptable for an inspection tail and floored by the watermark anyway.
- Reconnect/resume is a first-class, tested path (deploys disconnect all WebSockets). The DO is
  exercised in workerd (`runInDurableObject` + `runDurableObjectAlarm` with an injected poll seam — no
  live Postgres); the gapless watermark/keyset and a concurrent two-org isolation test run in the db
  pool against real Postgres + RLS.
- `wbhk.my` now serves two auth modes (unauthenticated path-token ingest; bearer-authed CLI tunnel),
  recorded in `docs/threat-model.md`.
- The future **web** dashboard tail cannot send an Authorization header on a browser WebSocket
  handshake — it will need a different transport (subprotocol token / short-lived ticket / a
  post-handshake auth message). Out of scope here; flagged for the frontend epic (human-verified when
  built).
- Forward levers, documented not built: live push-to-wake for sub-second latency, a per-org fan-out DO
  for very high listener counts, and jurisdiction-namespaced DO ids for EU residency
  (`LISTEN_SESSION.jurisdiction(...)`, per the residency model).

## amendment — `?since=now` (PR2, wedge phase 2)

The CLI's "from now" default (`wbhk listen` with no `--since`) tails only NEW events, but the opaque
cursor has no client-constructible time form and a cli-only seed can't get one (events.tail returns no
`nextCursor` when caught up — the common small-backlog case). So the upgrade accepts a `?since=now`
hint: on a NEW session (no durable cursor and no `?sinceCursor`), the DO seeds its resume cursor from
`latestTailCursor` — the latest event at/below the watermark, computed server-side under the session's
RLS — so the first poll skips the backlog. An empty endpoint leaves the cursor unset (oldest == now).
Reconnects still resume from the durable acked cursor. This is a minimal unblock; the broader
`--since` / cursor / cross-run-session design is a tracked follow-up.

## deviation from the canonical plan (flagged)

This supersedes `wedge-spine-plan.md` §0.10 (push + no-timer) under the reliability-first priority.
The internal docs should follow: update §0.10 and the phase-1/2 brief's write-path step ("best-effort
`waitUntil` live-fanout to active listen sessions") to the poll-only single-lane design, and add a
line to PRD §6's `wbhk.my` row noting the bearer-authed tunnel mode. Those live in the internal docs
repo and are tracked as a follow-up there, not in this PR.
