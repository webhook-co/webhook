// @webhook-co/shared — the single home for cross-surface types and pure helpers.
// Runtime-DB-free (no `pg`): web/cli/mcp import types here without pulling in the
// database client. The verification union + scheme enum + adapter interface live in
// webhooks-spec and are re-exported here so there is one import site for every surface.

export const SERVICE_NAME = "webhook" as const;

export * from "@webhook-co/webhooks-spec";

// Cross-runtime byte primitives (Workers + Node). Surfaced on the package entry so Worker-context
// callers reuse the canonical encoders instead of re-deriving hex/base64 (which would risk the
// dedup_key / pepper encodings drifting from the rest of the system). The base64url + HMAC + constant-
// time primitives back the cursor codec internally and the issuer's signed consent-ticket (Lane C A3c)
// — one set of encoders so a signed envelope can't drift between writer and verifier.
export {
  bytesToHex,
  bytesToB64,
  b64ToBytes,
  bytesToB64url,
  b64urlToBytes,
  timingSafeEqual,
  importHmacKey,
  utf8Encoder,
  utf8Decoder,
} from "./bytes";

export * from "./enums";
export * from "./ids";
export * from "./entities";
export * from "./listen-protocol";
export * from "./watermark";
export * from "./cursor";
export * from "./lag";
export * from "./since";
export * from "./audit";
export * from "./audit-chain";
export * from "./audit-anchor";
export * from "./r2";
export * from "./envelope";
export * from "./kms/local";
export * from "./kms/aws";
export * from "./kms/lru";
export * from "./secret-store";
export * from "./redaction";
export * from "./metering";
export * from "./secrets";
export * from "./ssrf";
export * from "./delivery-headers";
export * from "./delivery-rpc";
