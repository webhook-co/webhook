# ADR 0079 — Slack `url_verification` handshake on the ingest path

- status: accepted.
- date: 2026-06-26
- scope: `apps/engine` (the `wbhk.my` ingest hot path). Slice C of the inbound-verification lane (S2).

## context

Slack will not let an operator point an Events API subscription (or an interactive/slash endpoint) at a
URL until that URL passes a one-time **Request URL verification**: Slack POSTs a (signed) body
`{ "type": "url_verification", "challenge": "<nonce>", "token": "…" }` and requires the endpoint to echo
the `challenge` back in the 200 response. Until that round-trips, Slack refuses to save the URL — so a
`wbhk.my` ingest URL is unusable as a Slack destination without it.

This handshake arrives on the same `POST /<token>` path as real events, and it typically arrives **before**
the operator has registered a Slack signing secret (they're still configuring the integration), so it
cannot be gated behind signature verification. It is also **not an event**: storing it would surface a
junk "event" in the operator's stream on every Request URL (re)configuration.

The load-bearing constraint is the [ingest no-drop / durable-before-ACK floor](0013): the ingest path may
never throw into capture, and must never ACK an event whose body isn't durable. Any handshake handling has
to sit inside that floor without weakening it.

## decision

For a request whose **detected scheme is slack** (`detectScheme` → the `x-slack-signature` header is
present), attempt to parse the body as the handshake; if it is a well-formed
`{ type: "url_verification", challenge: <string> }`, echo `{ "challenge": "<value>" }` as a `200`
`application/json` response and **capture nothing** — no R2 PUT, no `ingest_event` row, no verify cycle.
Everything else falls through to normal capture.

Specifics:

- **Scheme-gated parse.** The JSON parse is confined to slack-detected traffic (`derived.provider ===
  "slack"`, already computed for dedup/verify), so non-Slack senders pay zero extra cost and can never
  trigger the branch. The detection is header-based, so a sender without `x-slack-signature` is never in
  this path — its `{type:"url_verification"}`-shaped body is just a normal event, captured.
- **Pure, total helper.** `slackUrlVerificationChallenge(raw)` is pure and total: any decode/parse failure,
  a wrong `type`, or a non-string `challenge` returns `null`. It can never throw, so the no-drop floor is
  intact — a malformed or non-handshake slack body falls straight through to capture.
- **Pre-capture.** The echo runs **before** the R2 PUT, so a handshake never writes a payload or a metadata
  row. It is a control message, not an event.
- **No signature check.** The challenge is Slack's own nonce bounced back 1:1. It carries no secret, we
  never store it, and echoing it leaks nothing (the caller already sent it). Requiring a signature here
  would break the real flow, where the secret often isn't registered yet. (Per Slack's own guidance, the
  url_verification response is the URL-reachability proof, distinct from per-event signature verification —
  which still applies to real events once a secret is registered, ADR-0011.)

## consequences

A `wbhk.my` ingest URL is now directly usable as a Slack Request URL: configuring it echoes the challenge,
Slack saves the URL, and subsequent real Slack events capture (and, once a signing secret is registered,
verify) normally. GitHub's `ping` needs nothing (it's a normal signed POST → capture + 2xx); GET
verification handshakes for other providers remain a `405` (unchanged). The no-drop floor is unchanged: the
handshake handler cannot throw, and only diverts a body that is unambiguously a Slack `url_verification`
control message — every other body, including a malformed one, is still captured.
