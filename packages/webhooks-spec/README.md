# @webhook-co/webhooks-spec

**Verify an inbound webhook signature from 144 providers, behind one interface.**

[![npm](https://img.shields.io/npm/v/%40webhook-co%2Fwebhooks-spec?label=npm&logo=npm)](https://www.npmjs.com/package/@webhook-co/webhooks-spec)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/webhook-co/webhook/blob/main/LICENSE)

Every provider signs webhooks slightly differently. Stripe concatenates a timestamp and the body with
a `.` and sends hex. GitHub sends `sha256=` plus hex over the raw body and no timestamp at all.
Shopify sends base64. Slack prefixes a version string. Square signs the request URL along with the
body. Some providers sign the JSON you'd get from `JSON.stringify`, and some sign the exact bytes that
arrived — which is why re-encoding a payload before verifying is the classic 3am bug.

This package encodes those differences once.

```sh
npm install @webhook-co/webhooks-spec
```

## Verify a webhook

```js
import { getAdapterForScheme } from "@webhook-co/webhooks-spec";

// `rawBody` MUST be the exact bytes you received — not a re-encoded copy.
const rawBody = new Uint8Array(await request.arrayBuffer());
const headers = [...request.headers]; // [["x-hub-signature-256", "sha256=…"], …]

// Name the provider whose endpoint this is. You registered the webhook, so you know.
const adapter = getAdapterForScheme("github");

const result = await adapter.verify({
  rawBody,
  headers,
  secrets: [process.env.WEBHOOK_SECRET], // several, newest first, for rotation
});

if (result.ok) {
  // result.keyId — which of your secrets matched
} else {
  // result.reason.code — MISSING_HEADER | MALFORMED_SIGNATURE | TIMESTAMP_TOO_OLD |
  //                      NO_MATCHING_KEY | WRONG_SECRET | RAW_BODY_MODIFIED | …
}
```

There is also `detectScheme(headers)`, but treat it as a hint, not an identification. Signature header
names are not unique across providers, and it returns the **first** registry match — so `x-signature`
alone resolves to `modern_treasury`, though Segment (SHA-1), Airwallex, Lemon Squeezy, ClickUp and
Mercado Pago all send that same header with different schemes. When you know the provider — and on
your own endpoint you do — pass the slug.

## The result is a diagnosis, not a boolean

A boolean tells you the signature didn't match. It doesn't tell you *why*, and "why" is the entire
problem — the failure modes look identical from the outside and have completely different fixes.

`verify()` returns a discriminated union. `WRONG_SECRET` means you're using the wrong key.
`RAW_BODY_MODIFIED` means your framework parsed and re-serialized the body before you got to it —
a different bug, in a different file, and the one people lose an evening to. `TIMESTAMP_TOO_OLD`
carries the actual skew and the tolerance, so you can see whether it's clock drift or a replay.

Heuristic sub-diagnoses carry a `confidence` field and never assert a cause that can't be backed.

## What's in the box

- **144 providers** — Stripe, GitHub, Shopify, Slack, Twilio, Square, Adyen, Braintree, HubSpot,
  Zoom, Linear, Vercel, Clerk, Supabase, Xero, Razorpay, and every
  [Standard Webhooks](https://www.standardwebhooks.com/) adopter, among many others.
- **Secret rotation** — pass every non-revoked secret; any match verifies, and `keyId` tells you which.
- **Constant-time comparison**, and each scheme's own timestamp-skew window.
- **Web Crypto only** — no Node built-ins — so it runs on Node 18+, Bun, Deno, Cloudflare Workers and
  other edge runtimes unchanged.
- **ESM and CJS**, with TypeScript declarations for both.

## Signing outbound webhooks

If you're the one *sending* webhooks, don't invent a scheme — implement
[Standard Webhooks](https://www.standardwebhooks.com/). The send side is here too:

```js
import { generateSigningSecret, signStandardWebhooks } from "@webhook-co/webhooks-spec";

const secret = generateSigningSecret(); // whsec_… — store this, show it to the receiver once

const headers = await signStandardWebhooks({
  id: "msg_2b1c…", // your message id
  timestamp: Math.floor(Date.now() / 1000).toString(),
  body: new TextEncoder().encode(JSON.stringify(payload)),
  secrets: [secret], // during rotation: [current, retiring]
});
// → { "webhook-id", "webhook-timestamp", "webhook-signature" }
```

Signing is **strict**: N secrets in, N signatures out, or it throws. A silently dropped retiring
secret would mean every receiver still pinned to it rejects your deliveries while your side reports
success — so a misconfigured signer fails loudly instead.

The output is byte-identical to what `standardWebhooksAdapter` verifies, so you can round-trip it.

## A missing provider is one config row

Most providers are a single declarative entry describing the header, the digest, how the signed
message is assembled, and how the secret is encoded. If yours isn't here, it's a small contribution
and we'd genuinely welcome it — see the
[open issue](https://github.com/webhook-co/webhook/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
for the recipe. The one hard requirement is a link to the provider's own signing documentation: a
wrong config row turns "unsupported" into "your signature is invalid", which is worse than nothing.

## Where this comes from

This is the verification core of [webhook.co](https://webhook.co) — a free, permanent, signed webhook
URL you can inspect and replay to localhost. The registry is extracted from the product rather than
written for the README, so it's exercised against real traffic. The package is standalone and has no
account, network call, or telemetry in it: one dependency (`zod`), and it never phones home.

Apache-2.0. Source and issues: [webhook-co/webhook](https://github.com/webhook-co/webhook).
