# @webhook-co/sdk

The official TypeScript SDK for the [webhook.co](https://webhook.co) API. A typed client with the
hardening you'd otherwise hand-roll: bearer auth, bounded retries with jitter, cursor pagination,
idempotency, and secret redaction — generated from the same OpenAPI contract the API is built on.

Runs anywhere `fetch` does: Node 18+, browsers, Deno, Bun, and Cloudflare Workers. Ships ESM and CommonJS.

## Install

```sh
npm install @webhook-co/sdk
# or: pnpm add @webhook-co/sdk / yarn add @webhook-co/sdk / bun add @webhook-co/sdk
```

## Quickstart

```ts
import { WebhookClient } from "@webhook-co/sdk";

const webhook = new WebhookClient({ apiKey: process.env.WEBHOOK_API_KEY! });

// Create an endpoint. The ingest URL is a credential, but it is NOT one-time.
const endpoint = await webhook.endpoints.create({ name: "orders-prod" });
console.log(endpoint.ingestUrl);

// Lost it? Read it back — the token is sealed at rest, so there is nothing to lose and no need to
// rotate (rotating would revoke the live URL and break every sender still posting to it).
const { ingestUrl } = await webhook.endpoints.revealIngestUrl(endpoint.id);

// List events for that endpoint (auto-paginates).
for await (const event of webhook.events.list(endpoint.id)) {
  console.log(event.id, event.provider, event.verificationState);
}
```

The API key is a `whk_`-prefixed token from your dashboard. Keep it server-side — this SDK never
prints it, but it's still a credential.

## Pagination

List methods return a `Paginator` you can iterate directly — it follows the cursor for you:

```ts
for await (const endpoint of webhook.endpoints.list({ name: "prod" })) {
  console.log(endpoint.id);
}

// Or collect everything (careful with large result sets):
const all = await webhook.deliveries.list({ status: ["failed"] }).collect();

// Need one page at a time (e.g. to build your own UI)? Use listPage:
const page = await webhook.endpoints.listPage({ limit: 50 });
console.log(page.items, page.nextCursor);
```

## Errors

Every failure is a `WebhookError` subclass, so you can narrow by `instanceof` — no string matching:

```ts
import {
  WebhookRateLimitError,
  WebhookNotFoundError,
  WebhookAuthenticationError,
} from "@webhook-co/sdk";

try {
  await webhook.endpoints.get(id);
} catch (err) {
  if (err instanceof WebhookNotFoundError) {
    // 404 — no such endpoint (or not visible to this org)
  } else if (err instanceof WebhookRateLimitError) {
    console.log(`retry after ${err.retryAfterMs}ms`);
  } else if (err instanceof WebhookAuthenticationError) {
    // 401 — the key is invalid, expired, or revoked
  } else {
    throw err;
  }
}
```

Each error carries `code` (a stable capability-error string), `status` (the HTTP status), and
`requestId` when the server sent one — include it in bug reports.

## Retries & idempotency

The client retries idempotent requests on transient failures (429/502/503/504 and network errors) with
capped exponential backoff and jitter, honouring `Retry-After`. It **never** blind-retries a
non-idempotent write — creating an endpoint, rotating a secret, or an un-keyed replay won't be sent
twice by the SDK. Replays carry an idempotency key, so those are safe to retry:

```ts
await webhook.events.replay({
  eventId: event.id,
  target: { kind: "destination", destinationId },
  idempotencyKey: crypto.randomUUID(),
});
```

Tune the budget per client:

```ts
const webhook = new WebhookClient({
  apiKey,
  maxRetries: 4, // default 2
  timeoutMs: 15_000, // default 30_000
});
```

## Payloads

`events.getPayload` decodes the wire envelope and hands you the exact bytes (length-checked, so a
truncated body throws rather than silently short-reading):

```ts
const { contentType, body } = await webhook.events.getPayload(event.id);
// body is a Uint8Array
```

## Configuration

| Option        | Default                    | Notes                                                      |
| ------------- | -------------------------- | ---------------------------------------------------------- |
| `apiKey`      | —                          | Required. A `whk_` API key.                                |
| `baseUrl`     | `https://api.webhook.co`   | Must be https (loopback http allowed for self-host / dev). |
| `fetch`       | the runtime global         | Pass your own (custom agent, instrumentation).             |
| `maxRetries`  | `2`                        | Retries after the first attempt, idempotent requests only. |
| `timeoutMs`   | `30000`                    | Per-request wall-clock budget.                             |
| `refreshAuth` | —                          | Hook to swap in a rotated bearer on a 401 (OAuth flows).   |
| `onDebug`     | —                          | Redacted, single-line diagnostics — never the raw key.     |

## API surface

`endpoints` (list · listPage · get · create · delete · rotate · `providerSecrets` add/list/revoke) ·
`events` (list · listPage · get · getPayload · tail · replay) · `deliveries` (list · listPage · get) ·
`replayDestinations` (create · list · delete · enable · setOrdered · rotateSigningSecret ·
listSigningSecrets) · `subscriptions` (create · list · delete) · `audit.verify` · `whoami`.

## License

Apache-2.0
