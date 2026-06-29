// Shopify verify adapter — the registry instance produced from SHOPIFY_CONFIG (./config). Header
// `X-Shopify-Hmac-Sha256: <base64>`, HMAC-SHA256 over the raw body (base64, not hex), keyed by
// the app client secret (UTF-8), no signed timestamp. The recipe lives in the config; this named
// export is kept for the adapter's test suite.
// See https://shopify.dev/docs/apps/build/webhooks/subscribe/https

import { getAdapterForScheme } from "./registry";

export const shopifyAdapter = getAdapterForScheme("shopify")!;
