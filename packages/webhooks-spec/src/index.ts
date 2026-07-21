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
// Byte + asymmetric primitives the engine's handshake dispatcher reuses (Discord Ed25519 PING verify).
export { hexToBytes } from "./bytes";
export { verifyEd25519 } from "./adapters/asymmetric";
// The provider vocabulary (single source of truth) + the config-driven adapter factory.
// packages/shared re-exports PROVIDERS/ProviderSchema/Provider as the cross-surface definition.
export {
  PROVIDERS,
  ProviderSchema,
  RETIRED_PROVIDERS,
  RETIRED_PROVIDER_ALIASES,
  canonicalProvider,
  SW_SECRET_PROVIDERS,
  // The full config-driven recipe map — consumed by @webhook-co/webhooks-recipes to derive the
  // human-facing signature recipes (build-time only; pure data, no crypto pulled into a DOM bundle).
  PROVIDER_CONFIGS,
  type Provider,
  type HmacProviderConfig,
  type MessagePart,
  type SignatureFormat,
  type TimestampSource,
  type SignatureEncoding,
  type HmacDigest,
  type KeyDerivation,
} from "./adapters/config";
export { makeHmacAdapter } from "./adapters/factory";
// The bespoke-adapter slug set — the parity source of truth for @webhook-co/webhooks-recipes.
export { BESPOKE_ADAPTER_SLUGS } from "./adapters/bespoke";
// Tier-4 non-cryptographic authenticity: the operator-configured-header provider set + its secret
// validator, single-sourced so the contract rejects a malformed `{header, token}` secret at registration.
export { isUsableConfiguredHeaderSecret } from "./adapters/bespoke/token-auth";
export { CONFIGURED_HEADER_PROVIDERS } from "./adapters/bespoke/token-auth-providers";
// GET-handshake verify-token secret shape (Meta hub.verify_token / eBay): the provider set, the typed
// seal-blob (de)serializer, and a constant-time compare, single-sourced for the contract / db / engine.
export {
  parseVerifyTokenSecret,
  serializeVerifyTokenSecret,
  VERIFY_TOKEN_PROVIDERS,
  verifyTokenEqual,
} from "./adapters/verify-token";
// Braintree `?bt_challenge=` handshake needs the integration PUBLIC key (separate from the private-key
// signing secret) sealed as a typed blob under the `braintree` slug — single-sourced for db / engine.
export {
  BRAINTREE_CHALLENGE_PATTERN,
  BRAINTREE_PUBLIC_KEY_PROVIDERS,
  parseBraintreePublicKey,
  serializeBraintreePublicKey,
} from "./adapters/braintree-public-key";

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

export {
  serializeProviderSecretPlaintext,
  validateProviderSecretShape,
  type ProviderSecretKind,
  type ProviderSecretShapeInput,
  type ProviderSecretShapeResult,
} from "./provider-secret-shape";
