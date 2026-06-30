# ADR 0086 — GET verification-handshake dispatcher on the ingest path

- status: accepted.
- date: 2026-06-30
- scope: `apps/engine` (the `wbhk.my` ingest hot path). S8 Slice 2. This ADR covers the dispatcher seam +
  the **no-secret** protocols (PR1); the secret-based protocols (Meta verify-token, X CRC, eBay) extend it
  in follow-up PRs under this same ADR.
- relates: [0085](0085-ingest-accept-all-verbs-method-liveness.md) (accept-all-verbs + the per-token GET
  liveness this sits in front of), [0079](0079-slack-url-verification-handshake.md) (the POST-side Slack
  `url_verification` handshake this mirrors), [0078](0078-inbound-verification-provider-secret-management.md)
  (the sealed `provider_secrets` store the secret-based protocols reuse), [0013](0013-ingest-durability-ordering.md)
  (the no-drop / durable-before-ACK floor preserved).

## context

Many providers will not activate a webhook subscription until the endpoint passes a **GET verification
handshake**: the provider fires a GET carrying a challenge, and the endpoint must echo or compute the
expected response, or the subscription silently fails. Accept-all-verbs (ADR-0085) made `wbhk.my/<token>`
answer any GET with a generic liveness — which is *not* the challenge response, so Meta (FB/IG/WhatsApp/
Messenger), X/Twitter (CRC), Dropbox, eBay, and Adobe could not complete setup against a `wbhk.my` URL.
This is the single largest sender-class gap a POST-only-handshake design left open.

The same load-bearing constraint as the Slack handshake (ADR-0079) applies: the dispatcher may never throw
into capture, and must never write an event for a control message.

## decision

A **GET-handshake dispatcher** runs in `handleIngest` **after token resolution** (so it only answers for a
known token — unknown → 404, unchanged) and **before the paused/liveness/capture flow**. If a GET carries a
recognized challenge protocol, it returns that protocol's response; otherwise it returns `null` and the GET
falls through to the normal accept-all-verbs capture + liveness. It mirrors the Slack divert exactly:

- **Pure + total responders.** Each protocol is a pure function (`apps/engine/src/handshake.ts`) — parse →
  return the `Response` or `null`, **never throw** — so the no-drop floor is never at risk.
- **Pre-capture, captures nothing, never meters.** The divert returns before the R2 PUT and the
  `ingest_event` insert. A handshake is a control message, not an event — no row, no billable unit.
- **Runs even on a paused endpoint.** Subscription *setup* is not ingestion; a paused endpoint must still be
  able to complete a provider's verification. (Placed before the paused branch for that reason.)
- **Detection by the request's own distinctive params/headers, mutually exclusive.** One protocol's request
  can never trigger another's path (`hub.challenge` / `crc_token` / `challenge_code` are distinct from the
  bare `challenge`). A garbage/unknown GET returns `null`, never a 500.
- **No new token oracle.** The dispatcher runs after `resolve`, so it exposes only the same known-vs-unknown
  signal accept-all-verbs already does; ingest tokens are high-entropy CSPRNG.

**PR1 — the no-secret protocols** (this change): **Dropbox** and **Adobe I/O Events** echo a bare
`?challenge=<v>` as `text/plain` with **`X-Content-Type-Options: nosniff`** (Dropbox requires it; with it the
echo is inert regardless of content — a hostile `?challenge=<script>` is returned as inert text, never HTML).
**Adobe Acrobat Sign** echoes the `X-AdobeSign-ClientId` request header back on a 200. None need a secret —
the echoed value is the caller's own, proving URL control (like the Slack nonce).

**Secret-based protocols (follow-up PRs under this ADR):** **X/Twitter CRC** (`crc_token` →
`{"response_token":"sha256="+base64(HMAC-SHA256(consumerSecret, crc_token))}`) reuses the endpoint's existing
sealed `x` provider secret; **Meta** (`hub.challenge`/`hub.verify_token` → echo iff the per-endpoint
verify-token matches, else 403) and **eBay** (`challenge_code` → `SHA256(code+verifyToken+endpoint)`) store a
user-chosen verify-token sealed via the existing `endpoints.addProviderSecret` capability (the Tier-4
configured-header precedent — no new table, no migration). The unseal reuses the engine's existing
KMS-backed `SecretStore.openString`, exposed as a pre-capture dep (the engine remains the sole unsealer).

## consequences

A `wbhk.my` URL becomes usable as a Dropbox / Adobe verification target immediately (PR1), and as a Meta / X
/ eBay target once the secret-based PRs land — closing the largest named integration gap. The no-drop floor
and metering posture are unchanged: handshakes write no row and bill nothing, exactly like the Slack
control-message divert. The verify-token storage reuses the sealed provider-secret surface, so there is no
new schema, grant, or KV-resolution path. The dashboard form for the verify-token is web-deferred (S1).
