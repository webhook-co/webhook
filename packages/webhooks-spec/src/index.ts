// Standard Webhooks signing/verification helpers (send and receive). Do not
// hand-roll signature schemes — follow https://www.standardwebhooks.com/ (ADR-0008).
// This package is a leaf: it owns the verification union + scheme enum + the adapter
// interface, which packages/shared re-exports as the cross-surface source of truth.

export const STANDARD_WEBHOOKS_VERSION = "v1" as const;

export * from "./scheme";
export * from "./verification";
export * from "./adapter";

// Per-scheme verify adapters — all five (Stripe, GitHub, Shopify, Slack, Standard
// Webhooks) are fully functional. The registry + header-based detection are the entry
// points every surface uses.
export { stripeAdapter } from "./adapters/stripe";
export { githubAdapter } from "./adapters/github";
export { shopifyAdapter } from "./adapters/shopify";
export { slackAdapter } from "./adapters/slack";
export { standardWebhooksAdapter } from "./adapters/standard-webhooks";
export {
  getAdapterForScheme,
  detectScheme,
  ADAPTER_SCHEMES,
  type AdapterScheme,
} from "./adapters/registry";
export { MAX_VERIFIABLE_BODY_BYTES, findHeader } from "./adapters/shared";
