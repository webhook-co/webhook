# ADR 0080 — Config-driven HMAC verification registry: 5 → 62 inbound providers

- status: accepted.
- date: 2026-06-29 (amended 2026-06-30: the deferred Tier-2 long-tail was subsequently built/resolved —
  56 → 62, see "status / outcome" + "the bespoke Tier-2 long-tail" below).
- scope: `packages/webhooks-spec` (the verify engine + the provider registry) + `apps/engine` (the
  registered-provider selection + the request-context threading on the ingest hot path). No migration
  (the `provider` columns are free-form text; new slugs need no schema change). No new API/contract
  surface — `ProviderSchema` is derived from the registry, so the CLI/MCP/contract provider inputs and
  the auto-iterating gates inherit every new provider for free.

## context

After ADR-0078 the product verified **5** inbound providers (Stripe, GitHub, Shopify, Slack, Standard
Webhooks) via hand-written adapters. Every other sender's events landed `verified:false` for lack of an
adapter. A 176-agent adversarially-verified research study of 84 providers
(`internal/research/provider-verification-matrix.md`) showed the ecosystem is overwhelmingly **HMAC over
a small set of shaping parameters** — the same audited crypto, differing only in declarative data
(which header carries the signature, how it's encoded, what bytes are signed, how the key is derived).
Writing N more bespoke adapter files would multiply the audited crypto surface N times.

## decision

Collapse per-provider adapters into **one audited engine + N declarative config rows**. A provider
becomes a single `HmacProviderConfig` row in `packages/webhooks-spec/src/adapters/config.ts`; the
factory (`makeHmacAdapter`) turns it into a `VerifyAdapter` routed through the SAME
`verifyHmacCore` — there is no per-provider crypto. `PROVIDERS` (one `as const` tuple) is the single
source of truth from which the `Provider` type, `ProviderSchema` (zod), `PROVIDER_CONFIGS`, the
`REGISTRY`/`ADAPTER_SCHEMES`, the skew table, and `packages/shared`'s re-exports all derive.

### Foundations

- **F1a/F1b** (`#251`/`#252`) — the registry seam + the factory; the 5 shipped adapters migrated into
  config rows. Their published-spec-vector tests stayed green byte-identical (the regression anchor).
- **F0** (`#253`) — **registered-provider-driven selection**. Adapter selection moved from first-match
  header sniffing to iterating the endpoint's distinct *registered* providers (the providers of its
  sealed signing secrets). This is what lets providers that **collide on a signature header** — GitHub
  & Meta both `x-hub-signature-256`; Bitbucket/Jira/Intercom all `x-hub-signature` — each be verifiable.
  A header-presence gate skips unsealing (a KMS DEK-unwrap on the durable-before-ACK path) for a request
  whose signature header is absent.
- **F2** (`#264`) — **digest + encoding parameterization**. `verifyHmacCore` takes a digest
  (`sha256`/`sha1`(20B)/`sha512`(64B)) — importing keys under that hash and keeping only correct-length
  decodes (a wrong-digest MAC can't match). Added a null-on-malformed `b64urlToBytes`. The mirrored
  `importHmacKey` is left byte-identical to `packages/shared` (a separate `importHmacKeyForHash`).
- **F3** (`#269`) — **request-context threading** on the ingest HOT PATH. `VerifyInput` gains
  `requestUrl`/`method`; `handleIngest` forwards `request.url`/`request.method` to the verify dep, which
  passes them to each adapter. Message parts gained `method`, `url{full|path}`, `queryParam`,
  `formField`, `sortedFormFields`. The no-throw capture floor is preserved with a triple guarantee
  (no-throw-by-construction — wrapped URL parse, lossy form decode, typed MALFORMED — plus the existing
  `verify.ts` and `ingest.ts` catches).

### Waves (config rows)

- **W0** (`#255`) — 6 Standard-Webhooks/Svix aliases (`resend`/`clerk`/`stytch`/`supabase`/`render`/`brex`).
- **W1** (`#257`/`#258`/`#260`/`#261`/`#262`/`#263`) — ~35 Tier-1 providers across raw-body, CSV multi-sig,
  millisecond/datetime timestamps, semicolon/positional CSV signature formats, and DocuSign's numbered
  multi-header collector.
- **W2/W2b** (`#266`/`#268`) — non-SHA256: `vercel`/`intercom` (sha1), `paystack`/`authorize_net` (sha512,
  hex-decoded key), `sanity` (base64url, ms-timestamp, no replay window).
- **W3a** (`#271`) — 5 Tier-2 request-context providers: `square`/`trello`/`twilio`(form)/`mandrill`/
  `hubspot`(v3).

### Per-provider correctness gate

Every config row ships a regression test: a **published gold vector** where one exists (Stripe, Slack,
Standard Webhooks, Supabase/SW family, Sanity ×2, Square), else a **self-consistent KAT** that signs the
provider's exact documented message format, **plus a build-time re-read of the provider's primary
signing doc** by an independent review agent. A self-consistent KAT proves internal consistency, not
correctness-against-the-real-provider — the doc re-verify is what closes that gap, and it caught a
real, test-invisible false-reject in nearly every batch (Supabase's `v1,whsec_` secret tag; CircleCI
versioned-vs-rotation semantics; Zendesk/Twitch ISO-8601 timestamps; Recurly's prose-says-ms-but-
wire-is-seconds; DocuSign's 100-key ceiling; Authorize.Net's hex-decoded Signature Key — a utf8 key
would have rejected 100% of real webhooks).

## status / outcome

**62 verifiable providers** (5 → 62). The config-driven registry is the durable home for inbound
verification; a new HMAC provider is one config row. The config model's clean sweet spot reached **56**;
the remaining Tier-2 providers were then built — five more as **config rows on small engine extensions**
(adyen/mailgun via a JSON-body signature source, mercado_pago via a `conditionalField` part, braintree
via a `formField` source + `pipePairs` format + `sha1-secret` key derivation), and four/five via a
**bespoke-adapter seam** (`adapters/bespoke/`) the registry prefers over the config-derived adapter for
schemes a single HMAC config can't express (Twilio's runtime form/JSON modes, Contentful's dynamic
canonical request, Plivo V3's stateful URL/query/body glue). `PROVIDER_CONFIGS` is now PARTIAL — a
bespoke provider has no config row and the registry throws at load if a slug has neither.

## the URL-signing trade-off (W3a)

Square/Trello/Mandrill/HubSpot sign the configured notification URL. We feed `requestUrl` (the live
request URL) — the only value held (no per-secret stored notification URL). For wbhk.my the request URL
**is** the configured ingest URL, so it matches in the common case; a non-canonical configured URL
(trailing slash, provider-appended query, proxy scheme) fails **closed** (a reject, never a forge),
which is the right posture for a best-effort Tier-2 adapter. A future hardening option is to thread the
endpoint's configured URL rather than the reconstructed request URL.

## the bespoke Tier-2 long-tail (resolved 56 → 62)

The config model's clean sweet spot ended at 56. The remaining Tier-2 providers each needed a new engine
primitive or a hand-written adapter; all were subsequently built (or dropped), each doc-confirmed against
the provider's official SDK/docs, often reproducing a published gold vector:

- **adyen** — signature INSIDE the JSON body (`…additionalData.hmacSignature`), hex-decoded key,
  colon-joined item fields. Built via a `signatureSource: jsonField` + `jsonField` message part. ✅
- **mailgun** (JSON / Webhooks-2.0) — `$.signature.{timestamp,token,signature}`. A pure config row on the
  Adyen JSON foundation. ✅ (legacy form-field mode deferred — modern Mailgun is JSON.)
- **mercado_pago** — `id:<lower(data.id)>;request-id:<x-request-id>;ts:<ts>;` manifest with a `data.id`
  lowercase + whole-segment omission. Built via a `conditionalField` message part. ✅
- **braintree** — `public_key|signature` pairs in the `bt_signature` form field, key = `SHA1(secret)`
  raw bytes. Built via a `formField` signature source + `pipePairs` format + `sha1-secret` derivation. ✅
- **twilio JSON mode** — `base64(HMAC-SHA1(url incl. bodySHA256))` + a `SHA256(body)`-vs-`bodySHA256`
  compare. A hand-written adapter (the bespoke seam) that delegates form mode to the config recipe. ✅
- **contentful** — a canonical `METHOD\nPATH\nHEADERS\nBODY` with a DYNAMIC signed-headers set. A
  hand-written adapter. ✅
- **plivo V3** — stateful `?`/`.` URL+query+body glue, multi-sig match-any, an `-Ma-V3` main-account
  alt-key. A hand-written adapter. ✅
- **messagebird** — DROPPED: its current scheme is JWT (`MessageBird-Signature-JWT`, HS256), out of the
  HMAC-message model (Tier-3); the legacy raw-HMAC scheme is deprecated in every SDK. ⛔

The bespoke seam: `adapters/bespoke/` ships hand-written `VerifyAdapter`s the registry prefers over the
config-derived one (`BESPOKE_ADAPTERS[slug] ?? makeHmacAdapter(PROVIDER_CONFIGS[slug])`). The
config-driven model still carries every provider it can; only the three runtime-branching / dynamic /
stateful schemes (twilio JSON, contentful, plivo) are hand-written.

## relates

ADR-0078 (the 5 hand-written adapters + the seal seam + the provider-secret surface this builds on),
ADR-0011 (inbound provider-signature verification), ADR-0008 (Standard Webhooks contract), ADR-0015
(provider-secret cache invalidation), ADR-0007/0009 (the KMS envelope the sealer wraps).
