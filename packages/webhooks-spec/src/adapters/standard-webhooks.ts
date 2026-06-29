// Standard Webhooks verify adapter — the registry instance produced from STANDARD_WEBHOOKS_CONFIG
// (./config). Standard Webhooks is THE contract for this product (ADR-0008); this is the
// receive-side counterpart to the signer. Headers `webhook-id`/`webhook-timestamp`/
// `webhook-signature` (space-delimited `v1,<base64>`), message `{id}.{ts}.{body}`, key
// `whsec_`+base64, HMAC-SHA256/base64. The recipe lives in the config; this named export is kept
// for the adapter's spec-vector test suite. See https://www.standardwebhooks.com/.

import { getAdapterForScheme } from "./registry";

export const standardWebhooksAdapter = getAdapterForScheme("standard_webhooks")!;
