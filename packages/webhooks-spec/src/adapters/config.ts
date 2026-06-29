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
  // W1 Tier-1 drop-ins, batch 1 — raw-body HMAC-SHA256.
  "razorpay",
  "sentry",
  "linear",
  "dropbox",
  "checkout_com",
  "lemon_squeezy",
  "coinbase_commerce",
  "dwolla",
  "gocardless",
  "notion",
  "meta",
  "woocommerce",
  // W1 batch 2 — raw-body (+ value prefix), CSV multi-sig, and a base64-keyed provider.
  "bitbucket",
  "atlassian_jira",
  "x",
  "clickup",
  "npm",
  "heroku",
  "dub",
  "cal_com",
  "asana",
  "circleci",
  "pagerduty",
  "airtable",
  // W1 batch 3 — timestamped Tier-1 (unix-SECONDS timestamp in the signed message).
  "calendly",
  "zoom",
  "customerio",
  "sinch",
  // W1 timestamp-format extension — millisecond (workos/front) and datetime/RFC3339 (zendesk/twitch)
  // timestamps, enabled by the factory's TimestampSource `format`.
  "workos",
  "front",
  "zendesk",
  "twitch",
  // W1 final framework-needs — non-comma CSV delimiter (paddle) + positional CSV (recurly).
  "paddle",
  "recurly",
  // W1 final framework-needs — numbered multi-header signatures (docusign).
  "docusign",
] as const;
export type Provider = (typeof PROVIDERS)[number];
export const ProviderSchema = z.enum(PROVIDERS);

/**
 * Per-provider replay-window tolerance, in seconds. Providers without a signed timestamp
 * (GitHub, Shopify) carry a value for uniformity; their adapters never enforce it. 300s
 * (5 min) matches Stripe's and Slack's documented defaults. `scheme.ts` folds `unknown` in
 * and exposes this as CLOCK_SKEW_TOLERANCE_SECONDS.
 */
const DEFAULT_TOLERANCE_SECONDS = 300;
/** Overrides for the few providers documenting a replay window other than the 300s default. */
const TOLERANCE_OVERRIDES: Partial<Record<Provider, number>> = {
  twitch: 600, // Twitch EventSub documents a 10-minute replay window.
};
export const PROVIDER_TOLERANCE_SECONDS: Readonly<Record<Provider, number>> = Object.fromEntries(
  PROVIDERS.map((p) => [p, TOLERANCE_OVERRIDES[p] ?? DEFAULT_TOLERANCE_SECONDS]),
) as Record<Provider, number>;

/**
 * How a scheme's signed timestamp is encoded for the replay-window check. `seconds` (default) and
 * `milliseconds` are canonical-integer epoch strings; `datetime` is an ISO-8601 / RFC3339 string
 * (parsed via Date.parse, tolerating fractional/nanosecond seconds). In EVERY case the RAW string is
 * what goes into the signed message — only the replay-window math differs.
 */
export type TimestampFormat = "seconds" | "milliseconds" | "datetime";

/**
 * Where a scheme's signed timestamp comes from. `none` = no signed timestamp (no replay window).
 * `header` = a dedicated header (Slack's `x-slack-request-timestamp`, Standard Webhooks'
 * `webhook-timestamp`). `sigField` = a `key=value` field embedded in the signature header itself
 * (Stripe's `t=` in `t=…,v1=…`). `format` defaults to `seconds`; a value that doesn't match its
 * format is a typed MALFORMED_SIGNATURE (never a silently-skipped replay check).
 */
export type TimestampSource =
  | { readonly kind: "none" }
  | { readonly kind: "header"; readonly header: string; readonly format?: TimestampFormat }
  | { readonly kind: "sigField"; readonly field: string; readonly format?: TimestampFormat };

/**
 * How the signature header value is parsed into one or more signatures (rotation / multi-sig):
 * - `plain`: the whole value (after stripping `signatureValuePrefix`) is a single signature
 *   (GitHub `sha256=…`, Shopify `<base64>`, Slack `v0=…`).
 * - `csvKv`: a `delimiter`-separated (default `,`) list of `key=value`; signatures are the values
 *   whose key is `sigKey`, and the other keys are exposed as fields (Stripe `t=…,v1=…`, sigKey `v1`;
 *   Paddle `ts=…;h1=…` with delimiter `;`, sigKey `h1`).
 * - `spaceList`: a space-separated list of `tag,value` entries; signatures are the values whose
 *   tag is `sigTag`, others skipped (Standard Webhooks `v1,<b64>` entries, `v1a` skipped).
 * - `positional`: a comma-separated list whose FIRST element is the timestamp and the rest are
 *   signatures (Recurly `<unix>,<sig1>,<sig2>`); the timestamp is exposed as `timestampField`.
 */
export type SignatureFormat =
  | { readonly kind: "plain" }
  | { readonly kind: "csvKv"; readonly sigKey: string; readonly delimiter?: string }
  | { readonly kind: "spaceList"; readonly sigTag: string }
  | { readonly kind: "positional"; readonly timestampField: string };

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
  /**
   * The lowercase header carrying the signature. When `numberedSignatureHeaders` is set this is the
   * canonical (`…-1`) header — used for detection and the engine's header-presence gate — while the
   * signatures themselves are collected across the numbered set.
   */
  readonly signatureHeader: string;
  /**
   * Collect signatures from NUMBERED headers `<prefix>1`, `<prefix>2`, …, `<prefix>max` instead of one
   * header value — each header carries one complete signature. DocuSign Connect emits one such header
   * per configured HMAC key (rotation = an extra header). When set, `signatureFormat` /
   * `signatureValuePrefix` are not applied (each numbered header IS one raw signature).
   */
  readonly numberedSignatureHeaders?: { readonly prefix: string; readonly max: number };
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

/**
 * Build a raw-body HMAC-SHA256 config: the signature is computed over the EXACT request body verbatim
 * (no timestamp, no header framing) — the most common provider scheme. `encoding` is hex or base64;
 * `prefix` is an optional fixed prefix on the header value to strip + require (e.g. `sha256=`).
 */
function rawBodyHmacConfig(
  slug: Provider,
  signatureHeader: string,
  encoding: "hex" | "base64",
  prefix?: string,
): HmacProviderConfig {
  return {
    slug,
    signatureHeader,
    ...(prefix !== undefined ? { signatureValuePrefix: prefix } : {}),
    encoding,
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
  // W1 Tier-1 drop-ins, batch 1 — raw-body HMAC-SHA256 (utf8 key, no timestamp). Headers + encoding
  // verified per provider against the S2.1 research matrix / official signing docs.
  razorpay: rawBodyHmacConfig("razorpay", "x-razorpay-signature", "hex"),
  sentry: rawBodyHmacConfig("sentry", "sentry-hook-signature", "hex"),
  linear: rawBodyHmacConfig("linear", "linear-signature", "hex"),
  dropbox: rawBodyHmacConfig("dropbox", "x-dropbox-signature", "hex"),
  checkout_com: rawBodyHmacConfig("checkout_com", "cko-signature", "hex"),
  lemon_squeezy: rawBodyHmacConfig("lemon_squeezy", "x-signature", "hex"),
  coinbase_commerce: rawBodyHmacConfig("coinbase_commerce", "x-cc-webhook-signature", "hex"),
  dwolla: rawBodyHmacConfig("dwolla", "x-request-signature-sha-256", "hex"),
  gocardless: rawBodyHmacConfig("gocardless", "webhook-signature", "hex"),
  notion: rawBodyHmacConfig("notion", "x-notion-signature", "hex", "sha256="),
  meta: rawBodyHmacConfig("meta", "x-hub-signature-256", "hex", "sha256="),
  woocommerce: rawBodyHmacConfig("woocommerce", "x-wc-webhook-signature", "base64"),
  // W1 batch 2 — raw-body (+ value prefix) + CSV multi-sig + a base64-keyed provider.
  bitbucket: rawBodyHmacConfig("bitbucket", "x-hub-signature", "hex", "sha256="),
  atlassian_jira: rawBodyHmacConfig("atlassian_jira", "x-hub-signature", "hex", "sha256="),
  // x (Twitter/X): POST event signature over the raw body (base64). The GET crc_token challenge (a
  // separate HMAC-of-the-token handshake) is an ingest-path follow-up, like asana's X-Hook-Secret.
  x: rawBodyHmacConfig("x", "x-twitter-webhooks-signature", "base64", "sha256="),
  clickup: rawBodyHmacConfig("clickup", "x-signature", "hex"),
  npm: rawBodyHmacConfig("npm", "x-npm-signature", "hex", "sha256="),
  heroku: rawBodyHmacConfig("heroku", "heroku-webhook-hmac-sha256", "base64"),
  dub: rawBodyHmacConfig("dub", "dub-signature", "hex"),
  cal_com: rawBodyHmacConfig("cal_com", "x-cal-signature-256", "hex"),
  // asana: raw-body HMAC; the X-Hook-Secret handshake (how the operator obtains the secret) is a
  // separate ingest-path follow-up — verification works once the secret is registered.
  asana: rawBodyHmacConfig("asana", "x-hook-signature", "hex"),
  // circleci: `circleci-signature: v1=<hex>` is a VERSIONED signature over the raw body (a single
  // signing secret; a future `v2=` would be a stronger scheme, not a second active secret). CircleCI
  // emits only `v1=` today, so accepting the listed `v1` is correct. FORWARD-WATCH: if a `v2=` ever
  // ships alongside `v1=`, prefer the highest version rather than any-matching (downgrade defense).
  circleci: {
    slug: "circleci",
    signatureHeader: "circleci-signature",
    signatureFormat: { kind: "csvKv", sigKey: "v1" },
    encoding: "hex",
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.circleci,
  },
  // pagerduty: `X-PagerDuty-Signature: v1=<hex>,v1=<hex>` — multiple ACTIVE secrets during rotation;
  // verify passes if ANY entry matches (verifyHmacCore compares the candidate MAC against all of them).
  pagerduty: {
    slug: "pagerduty",
    signatureHeader: "x-pagerduty-signature",
    signatureFormat: { kind: "csvKv", sigKey: "v1" },
    encoding: "hex",
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.pagerduty,
  },
  // airtable: `X-Airtable-Content-MAC: hmac-sha256=<hex>`; the macSecret is base64, decoded to the key.
  airtable: {
    slug: "airtable",
    signatureHeader: "x-airtable-content-mac",
    signatureValuePrefix: "hmac-sha256=",
    encoding: "hex",
    keyDerivation: "whsec-base64",
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.airtable,
  },
  // W1 batch 3 — timestamped Tier-1 (HMAC over a message that includes the signed timestamp).
  // calendly: `Calendly-Webhook-Signature: t=<unix>,v1=<hex>`; signed `{t}.{body}` (Stripe-shaped).
  calendly: {
    slug: "calendly",
    signatureHeader: "calendly-webhook-signature",
    signatureFormat: { kind: "csvKv", sigKey: "v1" },
    encoding: "hex",
    timestamp: { kind: "sigField", field: "t" },
    message: [{ kind: "timestamp" }, { kind: "literal", value: "." }, { kind: "body" }],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.calendly,
  },
  // zoom: `x-zm-signature: v0=<hex>` + `x-zm-request-timestamp`; signed `v0:{ts}:{body}` (Slack-shaped).
  zoom: {
    slug: "zoom",
    signatureHeader: "x-zm-signature",
    signatureValuePrefix: "v0=",
    encoding: "hex",
    timestamp: { kind: "header", header: "x-zm-request-timestamp" },
    message: [
      { kind: "literal", value: "v0:" },
      { kind: "timestamp" },
      { kind: "literal", value: ":" },
      { kind: "body" },
    ],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.zoom,
  },
  // customerio: `X-CIO-Signature` (bare hex) + `X-CIO-Timestamp`; signed `v0:{ts}:{body}` (no sig prefix).
  customerio: {
    slug: "customerio",
    signatureHeader: "x-cio-signature",
    encoding: "hex",
    timestamp: { kind: "header", header: "x-cio-timestamp" },
    message: [
      { kind: "literal", value: "v0:" },
      { kind: "timestamp" },
      { kind: "literal", value: ":" },
      { kind: "body" },
    ],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.customerio,
  },
  // sinch: `x-sinch-webhook-signature` (base64) + nonce + timestamp headers; signed `{body}.{nonce}.{ts}`.
  sinch: {
    slug: "sinch",
    signatureHeader: "x-sinch-webhook-signature",
    encoding: "base64",
    timestamp: { kind: "header", header: "x-sinch-webhook-signature-timestamp" },
    message: [
      { kind: "body" },
      { kind: "literal", value: "." },
      { kind: "header", header: "x-sinch-webhook-signature-nonce" },
      { kind: "literal", value: "." },
      { kind: "timestamp" },
    ],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.sinch,
  },
  // W1 timestamp-format extension — millisecond (workos/front) + datetime (zendesk/twitch) timestamps.
  // workos: `WorkOS-Signature: t=<ms>,v1=<hex>`; signed `{t}.{body}`; `t` is MILLISECONDS since epoch.
  workos: {
    slug: "workos",
    signatureHeader: "workos-signature",
    signatureFormat: { kind: "csvKv", sigKey: "v1" },
    encoding: "hex",
    timestamp: { kind: "sigField", field: "t", format: "milliseconds" },
    message: [{ kind: "timestamp" }, { kind: "literal", value: "." }, { kind: "body" }],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.workos,
  },
  // front: `X-Front-Signature` (base64) + `X-Front-Request-Timestamp` (MILLISECONDS); signed `{ts}:{body}`.
  front: {
    slug: "front",
    signatureHeader: "x-front-signature",
    encoding: "base64",
    timestamp: { kind: "header", header: "x-front-request-timestamp", format: "milliseconds" },
    message: [{ kind: "timestamp" }, { kind: "literal", value: ":" }, { kind: "body" }],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.front,
  },
  // zendesk: `X-Zendesk-Webhook-Signature` (base64) + `…-Timestamp` (ISO-8601 datetime); signed `{ts}{body}`.
  zendesk: {
    slug: "zendesk",
    signatureHeader: "x-zendesk-webhook-signature",
    encoding: "base64",
    timestamp: {
      kind: "header",
      header: "x-zendesk-webhook-signature-timestamp",
      format: "datetime",
    },
    message: [{ kind: "timestamp" }, { kind: "body" }],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.zendesk,
  },
  // twitch (EventSub): `Twitch-Eventsub-Message-Signature: sha256=<hex>` + Message-Id + Message-Timestamp
  // (RFC3339 datetime); signed `{messageId}{timestamp}{body}` (no separators); 10-minute replay window.
  twitch: {
    slug: "twitch",
    signatureHeader: "twitch-eventsub-message-signature",
    signatureValuePrefix: "sha256=",
    encoding: "hex",
    timestamp: { kind: "header", header: "twitch-eventsub-message-timestamp", format: "datetime" },
    message: [
      { kind: "header", header: "twitch-eventsub-message-id" },
      { kind: "timestamp" },
      { kind: "body" },
    ],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.twitch,
  },
  // W1 final framework-needs — non-comma CSV delimiter (paddle) + positional CSV (recurly).
  // paddle: `Paddle-Signature: ts=<unix>;h1=<hex>` (semicolon-delimited); signed `{ts}:{body}`.
  paddle: {
    slug: "paddle",
    signatureHeader: "paddle-signature",
    signatureFormat: { kind: "csvKv", sigKey: "h1", delimiter: ";" },
    encoding: "hex",
    timestamp: { kind: "sigField", field: "ts" },
    message: [{ kind: "timestamp" }, { kind: "literal", value: ":" }, { kind: "body" }],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.paddle,
  },
  // recurly: `recurly-signature: <unix>,<sig1>,<sig2>` (positional; multiple sigs during rotation);
  // signed `{ts}.{body}`. Verify passes if any listed signature matches a registered secret.
  recurly: {
    slug: "recurly",
    signatureHeader: "recurly-signature",
    signatureFormat: { kind: "positional", timestampField: "ts" },
    encoding: "hex",
    timestamp: { kind: "sigField", field: "ts" },
    message: [{ kind: "timestamp" }, { kind: "literal", value: "." }, { kind: "body" }],
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.recurly,
  },
  // docusign (Connect): one base64 HMAC-SHA256-over-raw-body per configured key, spread across the
  // NUMBERED headers `X-DocuSign-Signature-1`, `X-DocuSign-Signature-2`, … (so rotation = adding a key,
  // each emitting its own header). `numberedSignatureHeaders` collects them all; verify passes if any
  // matches a registered secret. `signatureHeader` (the -1 header, always present) drives detection.
  // `max: 100` matches DocuSign's documented ceiling of 100 HMAC keys — a registered secret that is the
  // operator's Nth key arrives in `…-N`, so under-scanning would silently false-reject it; over-scanning
  // is free (absent indices are simply skipped).
  docusign: {
    slug: "docusign",
    signatureHeader: "x-docusign-signature-1",
    numberedSignatureHeaders: { prefix: "x-docusign-signature-", max: 100 },
    encoding: "base64",
    toleranceSeconds: PROVIDER_TOLERANCE_SECONDS.docusign,
  },
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
