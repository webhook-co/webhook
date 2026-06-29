// The config-driven provider registry. The canonical provider vocabulary AND each migrated
// provider's HMAC verification recipe live HERE as plain data; the single audited engine
// (`verifyHmacCore` in ./shared) does the crypto, and `makeHmacAdapter` in ./factory turns
// one of these configs into a `VerifyAdapter`. `scheme.ts` already derives WEBHOOK_SCHEMES +
// the skew table from PROVIDERS, and the registry derives ADAPTER_SCHEMES from it, so the
// provider vocabulary has a single source. (F1b extends this to derive the REGISTRY map
// itself from the configs and retire the per-file adapters; today github/shopify are produced
// by the factory while stripe/slack/standard_webhooks are still bespoke.) packages/shared
// re-exports PROVIDERS/ProviderSchema as the cross-surface source of truth.
//
// This module is pure data + types — it imports no crypto and nothing from scheme.ts, so it
// sits below scheme.ts in the dependency graph (scheme.ts imports PROVIDERS from here).

import { z } from "zod";

/**
 * The recognized inbound providers (best-effort detection; verification never blocks
 * ingest). This tuple is THE source of truth for the provider/scheme vocabulary — keep it
 * in detection-precedence order (it becomes ADAPTER_SCHEMES). packages/shared re-exports it.
 */
export const PROVIDERS = ["stripe", "github", "shopify", "slack", "standard_webhooks"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const ProviderSchema = z.enum(PROVIDERS);

/**
 * Per-provider replay-window tolerance, in seconds. Providers without a signed timestamp
 * (GitHub, Shopify) carry a value for uniformity; their adapters never enforce it. 300s
 * (5 min) matches Stripe's and Slack's documented defaults. `scheme.ts` folds `unknown` in
 * and exposes this as CLOCK_SKEW_TOLERANCE_SECONDS.
 */
export const PROVIDER_TOLERANCE_SECONDS: Readonly<Record<Provider, number>> = {
  stripe: 300,
  github: 300,
  shopify: 300,
  slack: 300,
  standard_webhooks: 300,
};

/**
 * One ordered part of the signed message. The factory concatenates these to build the bytes
 * the HMAC is computed over: `body` is the EXACT captured raw bytes; `literal` is a constant
 * UTF-8 string. (Later waves add `timestamp` and `header` parts for timestamped/multi-header
 * schemes — kept out of F1a, which only needs the raw-body providers.)
 */
export type MessagePart =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "body" };

/** The signed message is the raw body verbatim unless a config says otherwise. */
export const RAW_BODY_MESSAGE: readonly MessagePart[] = [{ kind: "body" }];

/**
 * A config-driven HMAC verify adapter recipe. The factory (./factory) routes every one of
 * these through the SAME audited `verifyHmacCore`, so the only per-provider surface is this
 * declarative data — no bespoke crypto.
 */
export interface HmacProviderConfig {
  /** The provider slug; becomes the adapter's `scheme`. */
  readonly slug: Provider;
  /** The lowercase header carrying the signature. */
  readonly signatureHeader: string;
  /**
   * An optional fixed prefix on the header value that is stripped before decoding and
   * REQUIRED to be present (e.g. GitHub's `sha256=`). A header value without it is a typed
   * MALFORMED_SIGNATURE rather than a misleading mismatch.
   */
  readonly signatureValuePrefix?: string;
  /** How the signature is encoded in the header. */
  readonly encoding: "hex" | "base64";
  /** The signed message, assembled from these parts in order. Defaults to the raw body. */
  readonly message?: readonly MessagePart[];
  /** Replay tolerance (seconds); sourced from PROVIDER_TOLERANCE_SECONDS for one definition. */
  readonly toleranceSeconds: number;
}

// ── The migrated configs (F1a: the two raw-body providers). Stripe/Slack/Standard Webhooks
//    fold in at F1b once the factory grows timestamp + multi-signature support. ───────────

/** GitHub: `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the raw body. */
export const GITHUB_CONFIG: HmacProviderConfig = {
  slug: "github",
  signatureHeader: "x-hub-signature-256",
  signatureValuePrefix: "sha256=",
  encoding: "hex",
  toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.github,
};

/** Shopify: `X-Shopify-Hmac-Sha256: <base64>`, HMAC-SHA256 over the raw body. */
export const SHOPIFY_CONFIG: HmacProviderConfig = {
  slug: "shopify",
  signatureHeader: "x-shopify-hmac-sha256",
  encoding: "base64",
  toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.shopify,
};
