# ADR 0103 — Verified-gated auto-delivery + replay: never re-sign an event we didn't authenticate

- status: accepted.
- date: 2026-07-05
- scope: `apps/engine` (auto-delivery enqueue + the delivery-DO drain's signing), `apps/api` + `apps/web`
  (the two remote-replay arms), `packages/db` (the enqueue block + the drain's `events.verified` read),
  `packages/shared` (the `deliveryVerificationDecision` policy). S8-remainder Slice 3.
- relates: [0081](0081-remote-replay-to-destination.md) (the remote replay + re-signing this gates),
  [0084](0084-per-destination-send-side-signing.md) (the destination send-side signing this makes conditional
  on inbound verification), [0078](0078-inbound-verification-provider-secret-management.md) (the inbound
  verification that produces the `verified` flag), [0101](0101-always-shown-ingest-url-sealed-at-rest.md) (the
  always-shown ingest URL that makes the ingest URL easier to obtain — the trigger for closing this).

## context

Anyone who learns an endpoint's ingest URL can POST a **forged** event (the URL is a low-tier bearer
credential; authenticity rides on signature verification, not URL secrecy — and ADR-0101 makes the URL
always-shown). Today a forged, **unverified** event could (a) match an auto-delivery subscription and (b) be
replayed — and in **both** cases the engine RE-SIGNS it with the **destination's** Standard-Webhooks signing
secret. The downstream receiver then sees a valid **webhook.co** signature over attacker-authored content and
trusts it. Subscriptions default `require_verified = false` (permissive), and neither the delivery dispatcher,
the DO drain, nor either replay arm checked the event's verification.

An adversarial review killed the first design (a provider-specific "no-secret carve-out"): the event's
`provider` is **attacker-controlled and erasable** — omitting the signature headers drops the detected
provider to `null` and the state to `unattempted`, dodging any provider-keyed gate, and the forged event then
matches the **default** match-any subscription and is re-signed. The gate must key on a signal the attacker
cannot forge.

## decision

Gate on the **un-forgeable, server-derived verification state** (`deriveVerificationState`), never the
provider. One shared policy, `deliveryVerificationDecision(verified, verification) -> { deliver, sign }`
(`packages/shared`), enforced at **all three** re-signing chokepoints:

- **`verified` / `authenticated`** → **deliver + SIGN.** We authenticated the source.
- **`unattempted`** (no signature was checked — no secret, or the header was omitted) → **deliver, but NEVER
  sign.** Unverified forwarding is preserved (the event still delivers), but stripped of our signature — so a
  forged event can never carry webhook.co's vouch. We do not sign content we did not authenticate.
- **`failed`** (a signature WAS checked and **rejected**) → **BLOCK.** A rejected signature is forged/tampered
  — never forwardable; no configuration overrides this.

`sign` is exactly the un-forgeable `verified` bool, so a caller holding only that bool (the drain, reading a
queued row's `events.verified`) gates signing on it directly.

**The three chokepoints** (a shared helper, no per-site drift):
1. **Auto-delivery enqueue** (`enqueueAutoDeliveries`, `packages/db`): a `failed` event enqueues **nothing**.
   `unattempted`/`verified` enqueue as before. The DO drain then re-signs a queued delivery **only** when the
   source event `verified` (the `events.verified` column, joined into `listDueDeliveries` — no migration) —
   so an `unattempted` event is delivered UNSIGNED even to a signing destination.
2. **api remote-replay** (`apps/api/remote-replay.ts`): a `failed` event → a visible `FORBIDDEN` (operator
   action — errors, never a silent drop); the `signing` block is built only when `verified`.
3. **web dashboard replay** (`apps/web/replay-mutations.ts`): the same — a `failed` event surfaces a clear
   error; `unattempted` delivers unsigned. (The localhost/tunnel replay arm re-signs nothing and is
   untouched.)

`require_verified` on a subscription remains the **strict opt-in** (route only verified). This ADR adds the
*automatic baseline* — `failed` is never forwarded and only `verified` events are ever re-signed — without
flipping that default (which would break zero-config unverified forwarding).

## consequences

A forged event can no longer be delivered under webhook.co's signature: `failed` events are dropped from
auto-delivery + rejected on replay, and every `unattempted` (unverified) event is delivered **unsigned**. This
is a deliberate, customer-visible posture change: unverified events that were previously re-signed now arrive
unsigned, so a downstream that requires a webhook.co signature will reject them — which is correct, we should
never vouch for content we didn't authenticate; a customer who wants signed forwarding must configure inbound
verification. Legitimate unverified *forwarding* is preserved (the events still deliver). No migration (the
gate reads existing columns); no new subscription field. Keyed on the un-forgeable `verified` state, so the
provider-erasure bypass is structurally impossible.
