# ADR 0016 — replay-to-localhost: CLI delivers, the api records

- status: accepted
- date: 2026-06-18
- scope: `apps/api`, `packages/db`, `packages/cli`, `packages/contract`
- review severity: high (the first capability WRITE on the read surface)

## context

The wedge's payoff is replaying a captured webhook to a local dev server (`wbhk replay <id> --forward
http://localhost:3000`). `events.replay` is a frozen capability (ADR-0005): input `{eventId, target,
idempotencyKey}` where `target` is the closed `{kind:"localhost-tunnel", sessionId}`; output a
`DeliveryAttempt`; idempotent; its `delivery_attempts` table + the `(org_id, idempotency_key)` unique
index already exist. The api runs on Cloudflare Workers and **cannot reach a user's localhost** — so it
cannot perform a localhost delivery itself.

## decision

**Delivery is CLI-side; recording is server-side.** The CLI fetches the event's captured headers
(`events.get`) + exact body bytes (`events.getPayload`, ADR-0015), POSTs them to the loopback target
(exact bytes + the original `webhook-*` signature headers, minus hop-by-hop — Standard Webhooks
fidelity, so the local server can re-verify), and **on a local 2xx** calls `events.replay`, which
records a `delivery_attempts` row under the org's RLS and returns the `DeliveryAttempt`.

- **`events.replay` is bound on api + CLI; mcp/web stay exempt.** The `localhost-tunnel` target is
  CLI-intrinsic — an agent has no user-localhost session. It is a separate api handler (NOT in the
  shared `createReadHandlers` map that mcp binds), so the exemption can't drift.
- **The frozen input carries no HTTP outcome**, so the recorded row is `status="forwarded"`,
  `status_code=null`: an **audit + idempotency record** that a replay-to-localhost happened, not the
  local response. The live local status/latency is shown by the CLI. Capturing the real local
  `status_code` would need a contract evolution (see rejected).
- **Record only a local 2xx.** A non-2xx (the local server rejected) or an unreachable target exits the
  CLI non-zero and records nothing — `delivery_attempts` stays a log of *successful* deliveries.
- **Idempotent on `(org_id, idempotency_key)`**: a one-shot `replay` mints a fresh key per invocation
  (re-running is a new attempt); the continuous `listen --forward` (PR4) derives the key per event so
  at-least-once redelivery records once.
- **Forwarding is loopback-only** (`http(s)://` localhost/127.0.0.1/::1). Sending a captured payload +
  its provider signature to a non-local host would leak it off the machine.

## rejected alternatives

- **api/engine performs the localhost delivery.** Impossible from Workers (can't reach localhost). The
  CLI is the only place with a localhost session.
- **Extend the `events.replay` input with the local outcome** (status/code). Violates the frozen
  contract (ADR-0005, user-confirmed "honor the spec now"). The real-outcome record belongs to a future
  remote-delivery `Target` kind where the server itself delivers and observes the response.
- **Record every attempt, including failures.** The frozen input can't express a failure outcome
  meaningfully, and retries would spam rows; record-on-2xx keeps the table truthful + the idempotency
  key bounded.

## consequences

- The persisted `delivery_attempts` row is an audit/idempotency record, not the full HTTP outcome — a
  known limitation of the frozen input, revisited when a server-delivered `Target` kind lands.
- `wbhk listen --forward` (continuous, cursor-gated at-least-once forwarding) is a fast-follow (PR4); it
  reuses this forwarder + recording, adding only the per-event ack-on-2xx loop over the tunnel.
