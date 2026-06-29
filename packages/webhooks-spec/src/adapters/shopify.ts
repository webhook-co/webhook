// Shopify verify adapter — produced from the declarative SHOPIFY_CONFIG (./config) via the
// shared `makeHmacAdapter` factory. Header `X-Shopify-Hmac-Sha256: <base64>`, HMAC-SHA256 over
// the raw body verbatim (base64, not hex), keyed by the app's client secret (UTF-8). No signed
// timestamp. Behavior (and its tests) unchanged by the config migration.
// See https://shopify.dev/docs/apps/build/webhooks/subscribe/https

import { SHOPIFY_CONFIG } from "./config";
import { makeHmacAdapter } from "./factory";

export const shopifyAdapter = makeHmacAdapter(SHOPIFY_CONFIG);
