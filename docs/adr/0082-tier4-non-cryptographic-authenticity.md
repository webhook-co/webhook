# ADR 0082 — Tier-4 non-cryptographic authenticity: a distinct, weaker "authenticated" status

- status: accepted.
- date: 2026-06-30.
- scope: `packages/webhooks-spec` (a new `authenticity` field on the OK verification result + the
  `token-auth` adapter factory + 9 provider rows), `packages/shared` (a 4th `verificationState`,
  `authenticated`, + `deriveVerificationState`), `packages/db` (the `reads.ts` summary SQL CASE +
  filter predicate), `apps/web` (event-detail copy + the list-pill mirror), `packages/cli` (the
  events table + single-event render). **No migration** — the strength rides the existing
  free-form `provider` text and the existing `verification` jsonb column; `verified` stays a real
  boolean. **No new API/contract/scope surface** — `ProviderSchema` derives from the registry tuple
  and `VerificationStateSchema` simply gains a value, so the CLI/MCP/contract inputs, the events
  filter (`multiEnum(VerificationStateSchema)`), and the auto-iterating gates inherit it for free.

## context

ADR-0080 (the config-driven registry) + the S2.2 Tier-3 work (asymmetric / JWT / remote-fetch) cover
every provider that proves a webhook by a **cryptographic signature over the payload** — HMAC, RSA,
ECDSA, Ed25519, JWS. A residual class of senders does **not** sign the payload at all. They prove the
source by a **shared static secret presented verbatim** on each request:

- a fixed header carrying a token (GitLab `X-Gitlab-Token`),
- a token in a body field (Microsoft Graph `value[].clientState`),
- HTTP Basic credentials (`Authorization: Basic …` — Chargebee, Postmark, SparkPost),
- an **operator-chosen** header whose name the operator configures (Okta, BigCommerce, Datadog, Brevo).

This is a materially **weaker** guarantee than a signature: the secret is replayable, is transmitted on
every call, has no per-message binding to the body or a timestamp, and (for the configured-header class)
its placement is operator-defined. Treating such a match as "verified" — the same word we use for a
constant-time-verified RSA signature — would **overstate** the assurance to the developer reading the
dashboard, the CLI, or the API.

A pure-secrecy class (Docker Hub — only the ingest URL is secret, no per-message credential) has **no
per-message check** and is therefore **out of scope** (its only "auth" is the secrecy of the ingest URL,
which our platform already provides via the endpoint's own ingest token). Salesforce (mTLS + IP
allowlist — an ingress concern, not an adapter) and Mollie/Railway (no inbound check exists) are deferred.

## decision

Introduce a **non-cryptographic authenticity mode** surfaced as a status **clearly distinct from and
weaker than "verified"**: **`authenticated`**.

### 1. The result carries an optional strength, defaulting to "signature"

`VerificationResult`'s success arm gains an **optional** `authenticity: "token" | "basic"`
(`packages/webhooks-spec/src/verification.ts`). Absent ⇒ the result is a cryptographic signature (the
overwhelming default). `verificationOk(keyId, scheme, authenticity?)` **omits** the field for
`"signature"`, so **every existing cryptographic OK result stays byte-identical** — the ~40 adapter
tests asserting `toEqual({ ok: true, keyId, scheme })` keep passing, and the field rides the existing
stored `verification` jsonb with **no migration**. Only token/basic results carry it.

### 2. One adapter factory, four sources, constant-time

`token-auth.ts`'s `makeTokenAuthAdapter(config)` covers all nine providers. The presented credential is
extracted by one of four sources — `header` (fixed name), `jsonField` (a dot-path in the JSON body),
`basicAuth` (decode `Authorization: Basic b64(user:pass)`), or `configuredHeader` (the operator's secret
is a JSON `{ header, token }`, so the loop is secret-driven) — then compared to the registered secret
with the same **constant-time** primitive (`timingSafeEqual` over UTF-8 bytes) the HMAC engine uses. It
**fails closed**: a missing header → `MISSING_HEADER`, a non-JSON body / absent field → a typed
`MALFORMED_SIGNATURE`, no usable secret → `NO_MATCHING_KEY`, a present-but-wrong credential →
`SIGNATURE_MISMATCH`. It never throws (the durable-before-ACK ingest path tolerates no exceptions). For
Microsoft Graph, every notification in a batch shares the subscription's `clientState`, so checking
`value[0].clientState` is sufficient — an attacker cannot forge **any** element's value without the
secret. (The one-time MS-Graph `validationToken` echo and Okta `X-Okta-Verification-Challenge` are
subscription **handshakes** handled on the ingest path, separate from this per-message check, and remain
a tracked ingest-side follow-up.)

### 3. A 4th verification state, disjoint from "verified"

`VerificationStateSchema` gains `authenticated` (`packages/shared`). `deriveVerificationState`
(JS — `getEvent`, the `wbhk listen` tail) maps a `verified` result **with** an `authenticity` to
`authenticated`, else `verified`; the summary SQL CASE + filter predicate (`packages/db/src/reads.ts`)
mirror it on `verification->>'authenticity'`. The `verified` and `authenticated` buckets are **disjoint**
(`verified AND authenticity IS NULL` vs `verified AND authenticity IS NOT NULL`) so a row's pill can
never contradict the filter it matched. The events filter (`multiEnum`) and the CLI `--status` flag
inherit the new bucket automatically.

### 4. Surfaced as a distinct, honest badge everywhere

- **web** — the event detail renders an "Authenticated" pill (positive tone) whose copy states it is
  **non-cryptographic** (a shared token / HTTP Basic, the payload itself isn't signature-verified); the
  list pill shows a distinct "Authenticated".
- **CLI** — a distinct **yellow** `authenticated` word (not the green `verified`); the single-event
  detail reads `authenticated (<scheme>, non-cryptographic)`.
- **API/MCP** — the `authenticity` field + `verificationState` flow as structured data; no word is
  invented that conflates the two strengths.

## consequences

- **Honest assurance.** A token/basic match is never presented as a cryptographic verification; the
  weaker guarantee is legible at every surface. This is the load-bearing reason the field exists.
- **Coverage.** Nine providers that previously could only land `verified:false` are now first-class
  `authenticated` (GitLab, Microsoft Graph, Chargebee, Postmark, SparkPost, Okta, BigCommerce, Datadog,
  Brevo).
- **Zero-friction rollout.** No migration, no new scope, no contract break; existing crypto results and
  their tests are untouched; the registry/filter/gates auto-absorb the new slugs and the new state.
- **Operator-shape contract, validated at registration.** The configured-header providers register their
  secret as a JSON `{ header, token }` (both non-empty); the Basic providers register the plain
  `user:pass`. `endpoints.addProviderSecret` rejects a malformed/empty configured-header secret up front
  via `isUsableConfiguredHeaderSecret` (single-sourced from the factory, mirroring the SW-secret refine) —
  otherwise it would store fine yet verify as `NO_MATCHING_KEY` forever (indistinguishable from "no
  secret"). The factory independently skips an unusable secret, so an empty configured token can never
  produce a false `authenticated` match (the adversarial-review must-fix). The operator-configured-header
  and body-field providers have an empty detection header, so F0 runs them for every request to a
  registered endpoint (one constant-time compare — no KMS unwrap cost beyond the secret it already unseals).
- **Deferred / dropped (documented):** Docker Hub (no per-message secret — dropped), Salesforce (mTLS/IP
  — ingress, not an adapter), Mollie/Railway (no inbound check). The Tier-3 cryptographic close-out is
  documented separately (ADR-0083).
