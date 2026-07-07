# ADR 0106 — MCP webhook→agent triggers: a bounded-poll transport over the durable event log

- status: accepted.
- date: 2026-07-07
- scope: `packages/contract` (`triggers.create/list/revoke/wait` capabilities + the new `triggers:write`
  scope), `packages/db` (`agent_triggers` registry + the consumption handler), `packages/shared` (the
  verification-honest projection, the bounded-body RPC contract + encoder), `apps/engine` (the `PayloadReader`
  WorkerEntrypoint), `apps/mcp` + `apps/api` (bindings + routes), `packages/cli` (`wbhk triggers …`).
  Migration `0041_agent_triggers`. S5 slices A–C.
- relates: [0103](0103-verified-gated-delivery-and-resigning.md) (the verification honesty this reuses when
  deciding what a trigger may vouch for), [0015](0015-payload-body-read-on-api.md) (why the MCP surface holds
  no object-store binding — the reason the inline body rides a narrow engine RPC).

## context

Every webhook inspector lets you _look at_ received webhooks. The differentiator here is that a received
webhook becomes a **pushed agent event**: an AI agent, over MCP, subscribes to an endpoint and is _woken_
when a webhook lands — a first-class trigger, not something it polls a REST list for.

The obvious shape — MCP server-push (a standing `notifications` stream) — does not carry the guarantee we
need. The MCP spec's server-initiated messages are at-most-once: a replay store only fills _in-session_ stream
gaps, never events that arrived while the consumer was fully disconnected (new session, evicted session
object, offline). Standing-stream + subscribe support across clients is uneven; `tools/call` is universal.
Push also fights our topology: ingestion runs in the engine worker, while an MCP session lives in the MCP
worker keyed by a per-principal session binding — waking "the right client" cross-worker cuts against that
isolation and the spec's no-broadcast rule. The spec's own async primitive defaults to client-poll and tells
implementers not to rely on receiving notifications. Push is a latency _optimization_, not a delivery
mechanism.

Meanwhile the durable `events` table already **is** the log. A trigger is _pulled_ by its consumer — unlike
outbound HTTP delivery, which pushes to an uncontrolled third party and genuinely needs a per-destination
retry queue. Because we pull, we need only the immutable log plus a per-consumer cursor.

## decision

**Transport = a bounded short-poll MCP tool (`triggers.wait`) over the durable event log + an HMAC keyset
cursor.** Not server-push, not a per-subscriber queue.

- **`triggers.wait`** is an ordinary `tools/call`. Each call opens a fresh short-lived tenant connection, scans
  the endpoint's events past the caller's cursor under the org's row-level security, and returns immediately
  with what's visible (or an empty, caught-up page). The caller drives the cadence; no connection is held
  across a sleep, so N concurrent consumers cost N cursors over one shared log — fan-out and backpressure are
  solved by construction (a slow or dead agent just holds a stale cursor; ingestion never stalls, and the
  ingest hot path is untouched — no matcher, no enqueue, no wake).
- **Delivery guarantee: at-least-once.** The cursor advances **only** when the client passes the returned
  cursor back (ack-by-cursor). A crash before ack re-reads from the old cursor and re-delivers; nothing is
  lost. Each event carries its stable UUIDv7 id for trivial agent-side dedup. Ordering is per-endpoint by
  capture-completion time — explicitly _not_ send order.
- **Verification honesty (reuses [0103](0103-verified-gated-delivery-and-resigning.md)).** A trigger vouches
  only for what the server authenticated. Events whose signature was checked and **rejected** are never
  surfaced (filtered in-query, so the cursor still advances past them — a forged event can neither wake an
  agent nor stall its stream). Events with no signature checked surface with `vouched:false`; verified /
  authenticated events with `vouched:true`. The agent is never handed a forged event dressed as genuine.
- **Payload: a summary plus a bounded inline body.** Each trigger includes the captured request body so an
  agent is woken _with_ its payload, not a reference it must round-trip to fetch. The MCP surface holds **no
  object-store binding** by design ([0015](0015-payload-body-read-on-api.md)); the body rides a narrow engine
  RPC (`PayloadReader`) that is **identifier-only** — the caller passes its own authenticated org id plus
  event ids, and the engine reads each event's stored payload under that org's row-level security itself,
  fences the stored object key to the org/endpoint prefix, and returns at most a server-capped slice (default
  64 KiB). A cross-org or unknown id resolves to "not found" with no distinguishing signal. The fetch is
  best-effort: a transient failure degrades a page to summary-only rather than failing the consumer, so the
  agent still advances its cursor. `includeBody` (default on) and `maxBodyBytes` let a wake-only agent skip
  the fetch, at CLI / API / MCP parity.
- **Least privilege.** Reads (`list`, `wait`) require `events:read` — a trigger only ever surfaces data the
  caller can already read. Mutations (`create`, `revoke`) require a dedicated `triggers:write` scope, so a
  read-only key cannot register or tear down subscriptions.

## isolation

A trigger's org is the **pinned session principal**, never a request parameter, header, or row. The
subscription row is only a row-level-security existence gate that yields the endpoint id; the client never
selects an endpoint or a cursor's tenant. The opaque cursor is org/endpoint-unbound and inert across tenants
precisely because the endpoint comes from the authenticated subscription, not the cursor. The `agent_triggers`
table enforces row-level security with org-scoped policies only (no role-wide bypass) and a composite foreign
key binding every trigger to a same-org endpoint. Subscription liveness (not revoked, endpoint still present)
is re-checked each poll under the org's context, and the bounded wait shrinks the window in which a
just-revoked trigger could still read.

## consequences

- The ingest hot path is provably untouched: triggers are a read concern layered on the existing durable log.
- Server-push remains available as a **future, safe-degrading latency hint** — a "you may want to poll now"
  nudge on top of the same pull-with-cursor guarantee, never the guarantee itself.
- The at-least-once contract shifts idempotency to the consumer (dedup by event id) — the honest trade for
  never losing a trigger across disconnects.
- Retention is unbounded today, so a cursor cannot point below the oldest surviving event; the fail-loud
  "cursor expired" guard is implemented and tested but dormant until a retention job lands, at which point it
  wires in without a contract change.
