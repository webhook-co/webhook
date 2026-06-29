// Stripe verify adapter — the registry instance produced from STRIPE_CONFIG (./config). Header
// `Stripe-Signature: t=<ts>,v1=<hex>[,v1=…]`, message `{t}.{body}`, HMAC-SHA256/hex, 5-minute
// replay window. The verification recipe lives in the config; this named export is kept for the
// adapter's own spec-vector test suite. See https://stripe.com/docs/webhooks/signatures.

import { getAdapterForScheme } from "./registry";

export const stripeAdapter = getAdapterForScheme("stripe")!;
