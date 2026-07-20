// The human-facing "signature recipe" for one provider — the SINGLE source of truth for the
// programmatic provider pages and the interactive verifier. Every field here is DERIVED from
// `@webhook-co/webhooks-spec` (the config row for config-driven providers, or a curated-but-
// code-pinned descriptor for the hand-written bespoke adapters). The crypto MECHANICS cannot drift
// from the engine: a drift test re-derives the config-driven recipes and byte-compares the golden,
// and the bespoke recipes are pinned against the adapters' exported header/algorithm constants.
//
// It carries NO marketing prose and NO display name — pages join those from `provider-branding`.
// "Claims must not outrun the code": a field is present only when the registry actually asserts it
// (e.g. `replayWindow.enforced` is true ONLY when the scheme signs a timestamp AND enforces the
// window — never merely because a `toleranceSeconds` value exists).

/** Recipe families, coarse enough to drive page templates + the verifier's input needs. */
export type RecipeArchetype =
  | "raw-body-hmac" // HMAC over the raw body, no timestamp
  | "timestamped-hmac" // HMAC over a timestamp-framed message (Stripe/Slack-style)
  | "request-context-hmac" // HMAC binds method / URL / form fields (needs request context)
  | "sig-in-body-hmac" // signature lives in the JSON/form body, not a header
  | "standard-webhooks" // the Standard Webhooks (Svix) family
  | "asymmetric" // public-key verify (Ed25519 / ECDSA / RSA); registered "secret" is a public key
  | "jwt" // a signed JWT whose claims bind the body/URL (HS256)
  | "token" // NON-cryptographic: a shared static token / HTTP Basic (authenticated, not verified)
  | "remote-fetch"; // the verifying key is fetched from the provider (JWKS/cert) at verify time

/** Where the signature is carried. */
export type SignatureLocation = "header" | "json-body" | "form-body" | "numbered-headers";

/** An input the interactive verifier must collect to reproduce this scheme's verification. */
export type VerifierInput =
  | "secret" // shared secret OR (for asymmetric) the provider's public key
  | "payload" // the raw request body
  | "signatureHeader" // the signature header value the provider sent
  | "timestamp" // when the timestamp rides in a separate header
  | "requestUrl" // request-context schemes sign the URL
  | "method"; // request-context schemes sign the HTTP method

export interface RecipeDescriptor {
  /** Provider slug (the registry vocabulary). */
  readonly slug: string;
  readonly archetype: RecipeArchetype;
  /** Provenance: a config row, or a hand-written bespoke adapter. */
  readonly source: "config" | "bespoke";

  // ── Where the signature lives ────────────────────────────────────────────────
  readonly signatureLocation: SignatureLocation;
  /** The signature header (lowercase). `null` when the signature is not in a header. */
  readonly signatureHeader: string | null;
  /** Additional fixed signature headers (rotation), if any. */
  readonly additionalSignatureHeaders?: readonly string[];
  /** A required literal prefix on the header value (e.g. `sha256=`, `v0=`), if any. */
  readonly signatureValuePrefix?: string;
  /** Human description of how signatures are packed in the header value. */
  readonly signatureFormat: string;

  // ── The cryptography ─────────────────────────────────────────────────────────
  /** Human algorithm label, e.g. "HMAC-SHA256", "Ed25519", "ECDSA (P-256, SHA-256)", "HS256 JWT". */
  readonly algorithm: string;
  /** MAC encoding, when applicable (HMAC/asymmetric-in-header schemes). */
  readonly encoding?: "hex" | "base64" | "base64url";
  /** Human description of how the registered secret becomes the key. */
  readonly keyDerivation: string;

  // ── What is signed ───────────────────────────────────────────────────────────
  /** Human, one-line: e.g. "the raw request body", "`{timestamp}.{body}`". */
  readonly signedMessage: string;
  /** Machine parts (kinds + literals), used for near-duplicate clustering + rendering. */
  readonly signedMessageParts: readonly string[];

  // ── Timestamp / replay ───────────────────────────────────────────────────────
  readonly timestamp: {
    readonly source: string; // e.g. "the `stripe-signature` t= field", "the `x-slack-request-timestamp` header"
    readonly format: "seconds" | "milliseconds" | "datetime";
  } | null;
  readonly replayWindow: {
    /** True ONLY when the scheme signs a timestamp AND the engine enforces the window. */
    readonly enforced: boolean;
    readonly toleranceSeconds: number;
  };

  // ── Rotation / multi-signature ───────────────────────────────────────────────
  /** True when multiple candidate signatures may be present (rotation / multi-sig). */
  readonly rotation: boolean;

  // ── Verifier support ─────────────────────────────────────────────────────────
  /** Whether the interactive (browser-only) verifier can reproduce this. Remote-fetch = false. */
  readonly clientVerifiable: boolean;
  /** Which categories of input the verifier must collect. */
  readonly verifierInputs: readonly VerifierInput[];
  /**
   * Extra header values (beyond the signature header + a `timestamp` header) that are folded INTO the
   * signed message and therefore must ALSO be collected to reconstruct it — e.g. Standard Webhooks'
   * `webhook-id`, ConfigCat's id/timestamp headers, Sinch's nonce. Present only when the scheme signs
   * such headers; the verifier prompts for each. Empty/absent = the signature header + payload suffice.
   */
  readonly signedHeaders?: readonly string[];

  // ── Distinguishing quirks (rendered as page bullets) ─────────────────────────
  /** Derived, provider-distinguishing facts (non-default digest, hex-decoded key, anti-oracle guard…). */
  readonly quirks: readonly string[];
}
