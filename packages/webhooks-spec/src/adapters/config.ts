// The config-driven provider registry. The canonical provider vocabulary AND every provider's
// HMAC verification recipe live HERE as plain data; the single audited engine (`verifyHmacCore`
// in ./shared) does the crypto, and `makeHmacAdapter` in ./factory turns one of these configs
// into a `VerifyAdapter`. `scheme.ts` derives WEBHOOK_SCHEMES + the skew table from PROVIDERS,
// `registry.ts` derives the REGISTRY map (and ADAPTER_SCHEMES) straight from PROVIDER_CONFIGS,
// and packages/shared re-exports PROVIDERS/ProviderSchema as the cross-surface source of truth.
// So a new provider is ONE config row here — no hand-written adapter, no edits elsewhere.
//
// This module is pure data + types — it imports no crypto and nothing from scheme.ts, so it
// sits below scheme.ts in the dependency graph (scheme.ts imports PROVIDERS from here).

import { z } from "zod";

/**
 * The recognized inbound providers (best-effort detection; verification never blocks
 * ingest). This tuple is THE source of truth for the provider/scheme vocabulary — keep it
 * in detection-precedence order (it becomes ADAPTER_SCHEMES). packages/shared re-exports it.
 */
export const PROVIDERS = [
  "stripe",
  "github",
  "shopify",
  "slack",
  "standard_webhooks",
  // Standard Webhooks (Svix) aliases — same scheme, their own header trio + slug (W0).
  "clerk",
  "resend",
  "stytch",
  "supabase",
  "render",
  "brex",
] as const;
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
  clerk: 300,
  resend: 300,
  stytch: 300,
  supabase: 300,
  render: 300,
  brex: 300,
};

/**
 * Where a scheme's signed unix-seconds timestamp comes from. `none` = the scheme has no signed
 * timestamp (no replay window). `header` = a dedicated header (Slack's `x-slack-request-timestamp`,
 * Standard Webhooks' `webhook-timestamp`). `sigField` = a `key=value` field embedded in the
 * signature header itself (Stripe's `t=` in `t=…,v1=…`). A timestamp must be a canonical integer
 * string or it's a typed MALFORMED_SIGNATURE.
 */
export type TimestampSource =
  | { readonly kind: "none" }
  | { readonly kind: "header"; readonly header: string }
  | { readonly kind: "sigField"; readonly field: string };

/**
 * How the signature header value is parsed into one or more signatures (rotation / multi-sig):
 * - `plain`: the whole value (after stripping `signatureValuePrefix`) is a single signature
 *   (GitHub `sha256=…`, Shopify `<base64>`, Slack `v0=…`).
 * - `csvKv`: a comma-separated list of `key=value`; signatures are the values whose key is
 *   `sigKey`, and the other keys are exposed as fields (Stripe `t=…,v1=…,v1=…`, sigKey `v1`).
 * - `spaceList`: a space-separated list of `tag,value` entries; signatures are the values whose
 *   tag is `sigTag`, others skipped (Standard Webhooks `v1,<b64>` entries, `v1a` skipped).
 */
export type SignatureFormat =
  | { readonly kind: "plain" }
  | { readonly kind: "csvKv"; readonly sigKey: string }
  | { readonly kind: "spaceList"; readonly sigTag: string };

/**
 * One ordered part of the signed message. The factory concatenates these to build the bytes the
 * HMAC is computed over: `body` is the EXACT captured raw bytes; `literal` is a constant string;
 * `timestamp` is the resolved timestamp string; `header` is the verbatim value of a named header
 * (e.g. Standard Webhooks' `webhook-id`) — a referenced header that's absent is MALFORMED.
 */
export type MessagePart =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "timestamp" }
  | { readonly kind: "header"; readonly header: string }
  | { readonly kind: "body" };

/** The signed message is the raw body verbatim unless a config says otherwise. */
export const RAW_BODY_MESSAGE: readonly MessagePart[] = [{ kind: "body" }];

/**
 * How a registered secret string becomes the HMAC key bytes. `utf8` = the secret verbatim
 * (Stripe/GitHub/Shopify/Slack). `whsec-base64` = strip a `whsec_` prefix and base64-decode the
 * remainder to the raw key (Standard Webhooks).
 */
export type KeyDerivation = "utf8" | "whsec-base64";

/**
 * A config-driven HMAC verify adapter recipe. The factory (./factory) routes every one of these
 * through the SAME audited `verifyHmacCore`, so the only per-provider surface is this declarative
 * data — no bespoke crypto.
 */
export interface HmacProviderConfig {
  /** The provider slug; becomes the adapter's `scheme`. */
  readonly slug: Provider;
  /** The lowercase header carrying the signature. */
  readonly signatureHeader: string;
  /**
   * For `plain` signature formats only: a fixed prefix on the header value that is stripped
   * before decoding and REQUIRED to be present (e.g. GitHub's `sha256=`, Slack's `v0=`). A value
   * without it is a typed MALFORMED_SIGNATURE rather than a misleading mismatch.
   */
  readonly signatureValuePrefix?: string;
  /** How the header value is parsed into signatures. Defaults to `plain`. */
  readonly signatureFormat?: SignatureFormat;
  /** How the signature is encoded in the header. */
  readonly encoding: "hex" | "base64";
  /** How a registered secret becomes the HMAC key. Defaults to `utf8`. */
  readonly keyDerivation?: KeyDerivation;
  /** Where the signed timestamp comes from (drives the replay window). Defaults to `none`. */
  readonly timestamp?: TimestampSource;
  /** The signed message, assembled from these parts in order. Defaults to the raw body. */
  readonly message?: readonly MessagePart[];
  /** Replay tolerance (seconds); sourced from PROVIDER_TOLERANCE_SECONDS for one definition. */
  readonly toleranceSeconds: number;
}

// ── The provider configs. Each is the complete verification recipe for one provider. ─────────

/** Stripe: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]`; message `{t}.{body}`; HMAC-SHA256/hex. */
export const STRIPE_CONFIG: HmacProviderConfig = {
  slug: "stripe",
  signatureHeader: "stripe-signature",
  signatureFormat: { kind: "csvKv", sigKey: "v1" },
  encoding: "hex",
  timestamp: { kind: "sigField", field: "t" },
  message: [{ kind: "timestamp" }, { kind: "literal", value: "." }, { kind: "body" }],
  toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.stripe,
};

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

/**
 * Slack: `X-Slack-Signature: v0=<hex>` + `X-Slack-Request-Timestamp: <unix>`; message
 * `v0:{ts}:{body}`; HMAC-SHA256/hex.
 */
export const SLACK_CONFIG: HmacProviderConfig = {
  slug: "slack",
  signatureHeader: "x-slack-signature",
  signatureValuePrefix: "v0=",
  encoding: "hex",
  timestamp: { kind: "header", header: "x-slack-request-timestamp" },
  message: [
    { kind: "literal", value: "v0:" },
    { kind: "timestamp" },
    { kind: "literal", value: ":" },
    { kind: "body" },
  ],
  toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.slack,
};

/**
 * Build a Standard Webhooks (Svix-compatible, ADR-0008) config for a provider that signs with the
 * SW construction: headers `{prefix}-id` / `{prefix}-timestamp` / `{prefix}-signature` (the
 * signature is a space-delimited list of `v1,<base64>` entries; `v1a` asymmetric entries skipped),
 * message `{id}.{ts}.{body}`, key = a (optionally `whsec_`-prefixed) base64-decoded secret,
 * HMAC-SHA256/base64, 300s window. `prefix` is `webhook` for the standardized header names (and
 * Svix's newer headers) or `svix` for providers still emitting Svix's original `svix-*` trio.
 */
function standardWebhooksConfig(slug: Provider, prefix: "webhook" | "svix"): HmacProviderConfig {
  return {
    slug,
    signatureHeader: `${prefix}-signature`,
    signatureFormat: { kind: "spaceList", sigTag: "v1" },
    encoding: "base64",
    keyDerivation: "whsec-base64",
    timestamp: { kind: "header", header: `${prefix}-timestamp` },
    message: [
      { kind: "header", header: `${prefix}-id` },
      { kind: "literal", value: "." },
      { kind: "timestamp" },
      { kind: "literal", value: "." },
      { kind: "body" },
    ],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS[slug],
  };
}

/** Standard Webhooks (ADR-0008): the canonical `webhook-*` header trio. */
export const STANDARD_WEBHOOKS_CONFIG = standardWebhooksConfig("standard_webhooks", "webhook");

// Standard-Webhooks (Svix) aliases (W0) — same scheme, only the header trio + slug differ. clerk/
// resend/stytch still emit Svix's original `svix-*` headers; supabase/render/brex use the
// standardized `webhook-*` names. (brex's secret isn't `whsec_`-prefixed; whsec-base64 strips the
// prefix only if present, so a raw-base64 secret decodes the same.)
export const CLERK_CONFIG = standardWebhooksConfig("clerk", "svix");
export const RESEND_CONFIG = standardWebhooksConfig("resend", "svix");
export const STYTCH_CONFIG = standardWebhooksConfig("stytch", "svix");
export const SUPABASE_CONFIG = standardWebhooksConfig("supabase", "webhook");
export const RENDER_CONFIG = standardWebhooksConfig("render", "webhook");
export const BREX_CONFIG = standardWebhooksConfig("brex", "webhook");

/**
 * The complete provider→config map. `registry.ts` maps every entry through `makeHmacAdapter` to
 * build the REGISTRY, so this is the single place a provider's verification is defined.
 */
export const PROVIDER_CONFIGS: Readonly<Record<Provider, HmacProviderConfig>> = {
  stripe: STRIPE_CONFIG,
  github: GITHUB_CONFIG,
  shopify: SHOPIFY_CONFIG,
  slack: SLACK_CONFIG,
  standard_webhooks: STANDARD_WEBHOOKS_CONFIG,
  clerk: CLERK_CONFIG,
  resend: RESEND_CONFIG,
  stytch: STYTCH_CONFIG,
  supabase: SUPABASE_CONFIG,
  render: RENDER_CONFIG,
  brex: BREX_CONFIG,
};

/**
 * Providers whose secret is a Standard-Webhooks key (the `whsec-base64` derivation). Registration
 * validates the secret is actually decodable for these (via isUsableStandardWebhooksSecret) so a
 * mis-pasted secret is rejected up front rather than verifying as NO_MATCHING_KEY forever. Derived
 * from the configs, so a new SW-family provider is covered automatically.
 */
export const SW_SECRET_PROVIDERS: ReadonlySet<Provider> = new Set(
  PROVIDERS.filter((p) => PROVIDER_CONFIGS[p].keyDerivation === "whsec-base64"),
);
