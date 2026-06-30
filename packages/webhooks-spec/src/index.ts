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
export {
  MAX_VERIFIABLE_BODY_BYTES,
  findHeader,
  isUsableStandardWebhooksSecret,
} from "./adapters/shared";
// The provider vocabulary (single source of truth) + the config-driven adapter factory.
// packages/shared re-exports PROVIDERS/ProviderSchema/Provider as the cross-surface definition.
export {
  PROVIDERS,
  ProviderSchema,
  SW_SECRET_PROVIDERS,
  type Provider,
  type HmacProviderConfig,
  type MessagePart,
} from "./adapters/config";
export { makeHmacAdapter } from "./adapters/factory";
// Tier-4 non-cryptographic authenticity: the operator-configured-header provider set + its secret
// validator, single-sourced so the contract rejects a malformed `{header, token}` secret at registration.
export { isUsableConfiguredHeaderSecret } from "./adapters/bespoke/token-auth";
export { CONFIGURED_HEADER_PROVIDERS } from "./adapters/bespoke/token-auth-providers";

// Send-side signer (the counterpart to standardWebhooksAdapter): produce the Standard Webhooks v1
// signing headers + mint a signing secret. Used by the outbound delivery path (S3 Slice 2).
export {
  signStandardWebhooks,
  generateSigningSecret,
  WEBHOOK_ID_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type SignStandardWebhooksInput,
  type StandardWebhooksHeaders,
} from "./sign";
