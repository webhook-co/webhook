# ADR 0084 — outbound delivery signing: per-destination Standard Webhooks secrets, re-signed at the egress

- status: accepted
- date: 2026-06-30
- note: renumbered from 0082 (S2.2 claimed 0082/0083 on main in parallel)
- scope: `packages/webhooks-spec`, `packages/db`, `packages/contract`, `packages/shared`, `apps/engine`, `apps/api`, `packages/cli`
- review severity: high (signing byte-correctness + secret handling on the outbound path)

## context

ADR-0081 shipped server-side remote replay: the engine (the single egress chokepoint) delivers a stored
event's bytes to a pre-registered destination, behind the connect-time SSRF guard, forwarding the captured
inbound headers **verbatim**. But a verbatim delivery is unauthenticated from the receiver's point of view —
the inbound provider's signature was computed over a secret the destination does not hold, so the receiver
cannot tell a real webhook.co delivery from a spoofed POST to the same URL. The product contract is
**Standard Webhooks for both send and receive** (AGENTS.md); the receive side has shipped (the verify
adapters), but there was no send-side signer.

Three questions had to be answered (founder-decided after research):

1. **Secret scope.** The Standard Webhooks spec says *"signing keys should be unique per endpoint for
   symmetric signatures"* — where "endpoint" is the **receiver**. For remote replay the receiver is the
   `replay_destination`, not the source endpoint that captured the event. A per-source-endpoint secret would
   force a destination that receives replays from several endpoints to hold several secrets — breaking the
   one-secret-per-receiver model and the receiver's UX. So the secret is **per destination**.
2. **Header posture.** The inbound provider signature is unverifiable by the destination and, when the source
   was itself a Standard Webhooks provider, its `webhook-signature` would collide with ours. So we
   **re-sign**: strip the inbound signature headers and emit our own.
3. **Where signing happens + who holds the key.** The KEK lives only in the engine (it already unseals
   inbound verification secrets). So the api seals/relays ciphertext and the **engine** unseals + signs — the
   api never holds the signing plaintext, mirroring the provider-secret seal-only seam (ADR-0078).

## decision

1. **A send-side signer** (`packages/webhooks-spec/src/sign.ts`): `signStandardWebhooks({id,timestamp,body,
   secrets})` produces `webhook-id` / `webhook-timestamp` / `webhook-signature: v1,<sig>` over
   `${id}.${timestamp}.${body}`, byte-identical to what the existing verifier accepts (it reuses the same
   secret-decoding + HMAC helpers, and is pinned by the published spec KAT + a round-trip through the
   verifier). It signs with every supplied secret (space-delimited) for rotation overlap, and is **strict**:
   N secrets in → N signatures out, or throw (a silently-dropped secret must never yield a delivery the
   receiver rejects). `generateSigningSecret()` mints a `whsec_` + 256-bit-CSPRNG secret.

2. **Per-destination signing secrets** reuse the dormant `signing_keys` table, **re-pointed from the inbound
   endpoint to the replay destination** (migration 0026 — the table was unused). Multi-row-per-destination
   with `status` (active/retiring/revoked) gives **zero-downtime rotation**: rotate retires the current
   active, mints a fresh active, and revokes the prior retiring, bounding the honored set to two. Secrets are
   sealed under the KMS envelope and stored as ciphertext only; the `whsec_` plaintext is revealed **exactly
   once** — at first `replayDestinations.create`, or on `replayDestinations.rotateSigningSecret`.

3. **The engine re-signs at the egress.** `events.replay` now relays the destination's **sealed** secrets to
   the engine over the delivery RPC; the engine unseals them with its KMS-backed store and, in
   `guardedDeliver`, strips the inbound signature headers and sets webhook.co's. A signing failure is a
   recorded `failed` (never an unsigned POST). The `webhook-id` is the delivery-attempt id — a fresh
   idempotency key per delivery, so a deliberate replay is not deduped by the receiver as a stale duplicate.
   A destination with no signing secret (legacy) is delivered unsigned (the ADR-0081 verbatim behavior).

4. **Management at CLI + API parity** (web-deferred; mcp-exempt — an agent must not mint or exfiltrate a
   signing secret, the same posture as the rest of `replayDestinations.*`): the create response carries the
   one-time secret; `replayDestinations.rotateSigningSecret` reveals a fresh one; `listSigningSecrets`
   returns non-secret metadata. Both reuse the existing `endpoints:*` scopes.

## consequences

- A remote-replay delivery is now verifiable by the receiver as genuinely from webhook.co, with the standard
  zero-downtime rotation story. The signer is the reusable core that native outbound delivery (a later slice)
  will sign with too.
- The signing secret is revealed only once; a lost secret is recovered by rotating (not by re-reading). A
  re-`create` of an existing destination URL does not re-reveal — `signingSecret` is omitted in that response.
- The inbound provider signature does not survive a replay (re-sign strips it). The destination verifies
  webhook.co's signature, not the original sender's.
- No new infrastructure or bindings: the api seals via the existing engine seal entrypoint, and the engine
  already holds the KEK to unseal. Migration 0026 is additive and safe (the table was unused).
