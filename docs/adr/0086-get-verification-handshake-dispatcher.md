# ADR 0086 — GET verification-handshake dispatcher on the ingest path

- status: accepted.
- date: 2026-06-30
- scope: `apps/engine` (the `wbhk.my` ingest hot path) + the `provider_secrets` verify-token storage
  (`packages/contract`/`packages/db`/`packages/webhooks-spec`). S8 Slice 2. This ADR covers the dispatcher
  seam + the **no-secret** protocols (PR1), **X/Twitter CRC** (PR2a, the first secret-based protocol — adds
  the pre-capture unseal dep), and **Meta** verify-token compare (PR2b — adds the typed verify-token seal-
  blob + `addProviderSecret` `kind`). **eBay** hash (PR3) extends it under this same ADR.
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

**PR2a — X/Twitter CRC (this change):** a `crc_token` GET is answered with
`{"response_token":"sha256="+base64(HMAC-SHA256(consumerSecret, crc_token))}` (`application/json`, standard
base64, literal `sha256=` prefix). The HMAC key is the endpoint's **existing** sealed `x` provider secret
(the same consumer secret used for X's POST-signature verification — no new storage). The dispatcher unseals
it via a new **pre-capture unseal dep** (`IngestDeps.unsealSecret`): the engine's KMS-backed
`SecretStore.openString` (`getHandshakeUnsealStore`, mirroring the outbound `getSignStore`), with the AAD
rebuilt from the **authoritative** orgId/endpointId — so the engine remains the sole unsealer. An endpoint
with no `x` secret is not a resolvable CRC handshake → `null` → falls through. The unseal call is **guarded**
in `handleIngest` (a thrown unseal — KMS down / corrupt secret — never drops the request; it logs
`ingest.handshake_failed` and falls through to normal capture), preserving the no-drop floor. Byte-exactness
is pinned to a gold vector (`crc_token=9b4507b3-…` under `consumer_secret=z3ZX4v7m…` →
`sha256=Cytd4Sq+NvEcV3MMrXxWJGJx5A+y/lXzzU2Maartkx8=`).

**PR2b — Meta (FB/IG/WhatsApp/Messenger) (this change):** a `hub.mode=subscribe&hub.challenge=<v>&
hub.verify_token=<t>` GET echoes `<v>` as `text/plain` **iff** `<t>` equals a configured verify-token
(**constant-time**, `verifyTokenEqual`); configured-but-no-match → **403**; none configured → `null` → falls
through to capture (no oracle beyond an unknown token's). Meta's verify-token is a SECOND secret that
coexists with Meta's app secret (which keys the POST `x-hub-signature-256`) under the same `meta` slug, so
the slug alone can't disambiguate them. It is stored via the existing `endpoints.addProviderSecret`
capability — extended with a `kind: "signing_secret" | "verify_token"` (default `signing_secret`,
back-compat) — and sealed as a **typed blob** `{kind:"verify_token",token}` (single-sourced in
`packages/webhooks-spec` as `serializeVerifyTokenSecret`/`parseVerifyTokenSecret`). The engine unseals each
`meta` secret pre-capture (via PR2a's dep), skips the ones that aren't a verify-token blob (the app secret),
and compares — supporting rotation (any configured verify-token may match). **No new table, no migration**
(the seal layer is shape-agnostic); CLI/API/MCP stay at parity (the `kind` flows through the advertised
input shape; a CLI `--kind` flag + the MCP tool description are updated).

Because the verify-token is sealed under the same `meta` slug as the app signing secret, the **POST
signature-verification path is made kind-aware too** (`apps/engine/src/verify.ts`): it `parseVerifyTokenSecret`-
skips verify-token blobs so a verify-token is **never** used as a candidate HMAC key. Without this, the
deterministic, public blob wrapper would let anyone who learns the (lower-assurance, cleartext-in-`hub.
verify_token`-URL) verify-token forge a `verified=true` Meta webhook without Meta's app secret — a
verification downgrade. The discrimination is symmetric: the GET dispatcher uses ONLY verify-token blobs,
the POST verify path uses ONLY signing secrets.

**eBay (follow-up PR3 under this ADR):** `challenge_code` → `SHA256(code+verifyToken+endpoint)` reuses the
same verify-token kind + the pre-capture unseal dep.

## consequences

A `wbhk.my` URL becomes usable as a Dropbox / Adobe verification target (PR1), an **X/Twitter** CRC target
(PR2a), and a **Meta** (FB/IG/WhatsApp/Messenger) target (PR2b) — closing the largest named integration gap;
**eBay** follows in PR3. The no-drop floor and metering posture are unchanged: handshakes write no row and
bill nothing, exactly like the Slack control-message divert. The verify-token storage reuses the sealed
provider-secret surface (a new `kind` on `addProviderSecret`, a typed seal-blob), so there is no new schema,
grant, or KV-resolution path. The dashboard form for the verify-token is web-deferred (S1).

**Known limitation (kind not in metadata).** Because the kind lives inside the sealed ciphertext (no
migration), `listProviderSecrets` can't distinguish a verify-token from a signing secret under `meta` — both
show `provider=meta`. An operator who registers both should set distinct `label`s to tell them apart for
rotation/revoke. The clean fix (a `kind` column on `provider_secrets`, surfaced in the metadata) is deferred
to when PR3/eBay reuses this verify-token kind — it would also let the verify path filter by kind without an
unseal. Tracked, not blocking.
