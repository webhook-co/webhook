// Curated-but-code-pinned recipe descriptors for the HAND-WRITTEN (bespoke) verification adapters — the
// providers whose scheme the config-driven HMAC model can't express (asymmetric public-key verify, HS256
// JWTs, request-context canonicalization, remote-key fetch, and non-cryptographic token auth). Unlike the
// config-driven recipes (re-derived + byte-compared by a drift test), these are hand-authored HERE, so
// every load-bearing fact carries a trailing `file:line` citation into the adapter under
// `packages/webhooks-spec/src/adapters/` it was read from, and BESPOKE_HEADER_PINS (below) lets a test
// grep-assert each non-null header literal still lives in its adapter — a code-pin against drift.
//
// All `file:line` citations are relative to `packages/webhooks-spec/src/adapters/`.

import type { RecipeDescriptor } from "./types";

export const BESPOKE_RECIPES: Record<string, RecipeDescriptor> = {
  // ── Asymmetric (public-key verify; the registered "secret" IS the provider's public key) ──────────
  discord: {
    slug: "discord",
    archetype: "asymmetric",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-signature-ed25519", // bespoke/discord.ts:11
    signatureFormat: "hex-encoded 64-byte Ed25519 signature", // bespoke/discord.ts:1,13
    algorithm: "Ed25519", // bespoke/discord.ts:1 · asymmetric.ts:20-34
    encoding: "hex", // bespoke/discord.ts:13 (signatureEncoding)
    keyDerivation:
      "registered secret is the app's hex-encoded 32-byte Ed25519 public key, used verbatim", // bespoke/discord.ts:1-2,14 · ed25519-adapter.ts:74
    signedMessage:
      "`{timestamp}{rawBody}` — the timestamp header concatenated to the raw body, no separator", // bespoke/discord.ts:1,15 · ed25519-adapter.ts:69
    signedMessageParts: ["timestamp", "body"],
    timestamp: { source: "the `x-signature-timestamp` header", format: "seconds" }, // bespoke/discord.ts:1
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // ed25519-adapter.ts:35-42 (advisory only)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "timestamp"],
    quirks: [
      'The registered "secret" is Discord\'s hex-encoded 32-byte Ed25519 PUBLIC key, not a shared secret.', // bespoke/discord.ts:2
      "Timestamp and body are concatenated with NO separator (`{timestamp}{body}`).", // bespoke/discord.ts:15 (separator "")
      "The signed timestamp is bound into the message but no replay-age window is enforced — the signature is the authenticity guarantee; downstream dedupe handles replay.", // ed25519-adapter.ts:35-42
    ],
  },

  telnyx: {
    slug: "telnyx",
    archetype: "asymmetric",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "telnyx-signature-ed25519", // bespoke/telnyx.ts:11
    signatureFormat: "base64-encoded 64-byte Ed25519 signature", // bespoke/telnyx.ts:1,13
    algorithm: "Ed25519", // bespoke/telnyx.ts:1 · asymmetric.ts:20-34
    encoding: "base64", // bespoke/telnyx.ts:13 (signatureEncoding)
    keyDerivation:
      "registered secret is the account's base64-encoded 32-byte Ed25519 public key, used verbatim", // bespoke/telnyx.ts:2,14
    signedMessage: "`{timestamp}|{rawBody}` — timestamp, a literal `|`, then the raw body", // bespoke/telnyx.ts:1,15 · ed25519-adapter.ts:69
    signedMessageParts: ["timestamp", "literal:|", "body"],
    timestamp: { source: "the `telnyx-timestamp` header", format: "seconds" }, // bespoke/telnyx.ts:1
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // ed25519-adapter.ts:35-42 (advisory only)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "timestamp"],
    quirks: [
      'The registered "secret" is Telnyx\'s base64-encoded 32-byte Ed25519 PUBLIC key, not a shared secret.', // bespoke/telnyx.ts:2
      "Timestamp and body are joined by a literal pipe (`{timestamp}|{body}`).", // bespoke/telnyx.ts:1,15 (separator "|")
      "The signed timestamp is bound into the message but no replay-age window is enforced.", // ed25519-adapter.ts:35-42
    ],
  },

  sendgrid: {
    slug: "sendgrid",
    archetype: "asymmetric",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-twilio-email-event-webhook-signature", // bespoke/sendgrid.ts:14
    signatureFormat:
      "base64-encoded DER ECDSA signature (converted to IEEE-P1363 r||s for WebCrypto)", // bespoke/sendgrid.ts:1-4 · asymmetric.ts:180-224
    algorithm: "ECDSA (P-256, SHA-256)", // bespoke/sendgrid.ts:1 · asymmetric.ts:98-121
    encoding: "base64", // bespoke/sendgrid.ts:1 (base64 DER sig)
    keyDerivation:
      'registered secret is the dashboard "Verification Key" — base64 of the SPKI DER ECDSA P-256 public key', // bespoke/sendgrid.ts:2-4,43
    signedMessage: "`{timestamp}{rawBody}` — the `…-Timestamp` header concatenated to the raw body", // bespoke/sendgrid.ts:39
    signedMessageParts: ["timestamp", "body"],
    timestamp: {
      source: "the `x-twilio-email-event-webhook-timestamp` header",
      format: "seconds",
    }, // bespoke/sendgrid.ts:15,25-28
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // bespoke/sendgrid.ts:4-5 (no window enforced)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "timestamp"],
    quirks: [
      'The registered "secret" is SendGrid\'s base64 SPKI ECDSA P-256 PUBLIC key ("Verification Key"), not a shared secret.', // bespoke/sendgrid.ts:2-4
      "The DER-encoded ECDSA signature is converted to IEEE-P1363 raw r||s (64 bytes) before WebCrypto verify.", // bespoke/sendgrid.ts:30 · asymmetric.ts:180-224
      "The signed timestamp is bound into the message but no replay window is enforced.", // bespoke/sendgrid.ts:4-5
    ],
  },

  wise: {
    slug: "wise",
    archetype: "asymmetric",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-signature-sha256", // bespoke/wise.ts:14
    signatureFormat: "base64-encoded RSA signature", // bespoke/wise.ts:1,24
    algorithm: "RSA-PKCS1 (SHA-256)", // bespoke/wise.ts:1 · asymmetric.ts:41-68
    encoding: "base64", // bespoke/wise.ts:1,24
    keyDerivation:
      "registered secret is Wise's PUBLISHED public key as PEM (or bare base64 SPKI); separate sandbox + production keys", // bespoke/wise.ts:2-4,35-36
    signedMessage: "the raw request body", // bespoke/wise.ts:1,39
    signedMessageParts: ["body"],
    timestamp: null, // bespoke/wise.ts:4-5 (no signed timestamp)
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // bespoke/wise.ts:4-5
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader"],
    quirks: [
      'The registered "secret" is Wise\'s published RSA PUBLIC key (PEM or bare base64 SPKI), not a shared secret; separate sandbox and production keys.', // bespoke/wise.ts:2-4
      "The legacy unsuffixed `X-Signature` header is SHA-1 and is IGNORED; only `X-Signature-SHA256` is verified.", // bespoke/wise.ts:1-2
      "No signed timestamp; Wise documents replay protection via X-Delivery-Id / sent_at, handled by downstream dedupe.", // bespoke/wise.ts:4-5
    ],
  },

  keygen: {
    slug: "keygen",
    archetype: "asymmetric",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "keygen-signature", // bespoke/keygen.ts:23
    signatureFormat:
      'a draft-cavage HTTP-Signatures parameter set: `keyid=…,algorithm="ed25519",signature="<base64>",headers="…"`', // bespoke/keygen.ts:4-8,26-32
    algorithm: "Ed25519", // bespoke/keygen.ts:1,55 · asymmetric.ts:20-34
    encoding: "base64", // bespoke/keygen.ts:58 (the `signature` param is base64)
    keyDerivation: "registered secret is the account's Ed25519 public key as hex, used verbatim", // bespoke/keygen.ts:12-13,98
    signedMessage:
      "the reconstructed draft-cavage signing string — `(request-target)`, `host`, `date`, `digest` lines joined by `\\n`, where `digest` is `sha-256=<base64(sha256(rawBody))>` recomputed from the received body", // bespoke/keygen.ts:4-14,61-94
    signedMessageParts: ["method", "url:path", "header:host", "header:date", "body"],
    timestamp: null, // no timestamp is parsed/enforced; the signed `date` header is treated as a generic signed line
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // no window enforced (bespoke/keygen.ts has no freshness check)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "requestUrl", "method"],
    // The cavage `headers` list names these; the adapter reads each off the request and fails
    // MALFORMED ("signed header X is absent") without them, so the verifier MUST collect them.
    signedHeaders: ["host", "date"], // bespoke/keygen.ts:62-92 (findHeader per token)
    quirks: [
      'The registered "secret" is the account\'s Ed25519 PUBLIC key (hex), not a shared secret.', // bespoke/keygen.ts:12-13
      "Ed25519 over an HTTP Message Signatures / draft-cavage signing string, NOT a raw-body HMAC — request-context (needs HTTP method + URL for `(request-target)`).", // bespoke/keygen.ts:1-4,69-82
      "The `digest` line is RECOMPUTED as `sha-256=<base64(sha256(body))>` from the received body, never trusting the incoming Digest header — this is what binds the body.", // bespoke/keygen.ts:8-14,83-85
      'Only `algorithm="ed25519"` is handled; ecdsa-p256 / rsa-pss / rsa are rejected as MALFORMED (an absent algorithm defaults to ed25519).', // bespoke/keygen.ts:53-57
    ],
  },

  // ── JWT (HS256; the registered secret is the signing key, used verbatim as the UTF-8 HMAC key) ────
  messagebird: {
    slug: "messagebird",
    archetype: "jwt",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "messagebird-signature-jwt", // bespoke/messagebird.ts:23
    signatureFormat: "a compact HS256 JWT (`header.payload.signature`, base64url segments)", // bespoke/messagebird.ts:1-4 · jws.ts:53-68
    algorithm: "HS256 (JWT)", // bespoke/messagebird.ts:1 · jws.ts:87-90,99-128
    keyDerivation:
      'registered secret is the dashboard "Signing key", used VERBATIM as the UTF-8 HMAC key (never hex-decoded even though it looks like 64 hex chars)', // bespoke/messagebird.ts:6-8 · jws.ts:93-96,113-117
    signedMessage:
      "the JWT signing input `base64url(header).base64url(payload)`; the body is bound via the `payload_hash` claim (hex SHA-256) and the URL via `url_hash`", // bespoke/messagebird.ts:10-13,62-88 · jws.ts:64-65
    signedMessageParts: ["jwt-header", "jwt-payload"],
    timestamp: { source: "the JWT `exp` / `nbf` / `iat` claims", format: "seconds" }, // bespoke/messagebird.ts:59 · jws.ts:139-169
    replayWindow: { enforced: true, toleranceSeconds: 300 }, // bespoke/messagebird.ts:59 (enforceJwtWindow) · jws.ts:139-169
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "requestUrl"],
    quirks: [
      "HS256 JWT — the token authenticates the request via signed claims; it does NOT HMAC the raw body directly.", // bespoke/messagebird.ts:1-4
      "Body bound by the `payload_hash` claim (hex SHA-256 of the raw body); OMITTED when the body is empty (an absent hash with a non-empty body is rejected).", // bespoke/messagebird.ts:11,79-88
      "URL bound by the `url_hash` claim (hex SHA-256 of the raw request URL, verbatim) when present.", // bespoke/messagebird.ts:10,64-76
      "`iss` must equal `MessageBird`; freshness enforced via exp (upper) + nbf/iat (lower).", // bespoke/messagebird.ts:51,59 · jws.ts:139-169
    ],
  },

  netlify: {
    slug: "netlify",
    archetype: "jwt",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-webhook-signature", // bespoke/netlify.ts:13
    signatureFormat: "a compact HS256 JWT", // bespoke/netlify.ts:1-2 · jws.ts:53-68
    algorithm: "HS256 (JWT)", // bespoke/netlify.ts:1 · jws.ts:87-90,99-128
    keyDerivation:
      'registered secret is the configured "JWS secret token", verbatim UTF-8 HMAC key', // bespoke/netlify.ts:2-3 · jws.ts:93-96
    signedMessage:
      "the JWT signing input; the body is bound via the `sha256` claim (hex SHA-256 of the raw body)", // bespoke/netlify.ts:1-3 · jws-hash-binding.ts:52-60
    signedMessageParts: ["jwt-header", "jwt-payload"],
    timestamp: null, // bespoke/netlify.ts:1-2 (no iat/exp) · jws-hash-binding.ts never enforces a window
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // bespoke/netlify.ts:2 (no replay window)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader"],
    quirks: [
      'HS256 JWT with payload exactly `{ iss: "netlify", sha256: <hex SHA-256 of the raw body> }` — origin-authenticated + body bound by the `sha256` hash claim.', // bespoke/netlify.ts:1-3
      "No `iat` / `exp` claims → no replay window enforced.", // bespoke/netlify.ts:2
      "`iss` must equal `netlify`; secret used verbatim as UTF-8.", // bespoke/netlify.ts:2-3 · jws-hash-binding.ts:47-49
    ],
  },

  vonage: {
    slug: "vonage",
    archetype: "jwt",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "authorization", // bespoke/vonage.ts:14
    signatureValuePrefix: "Bearer ", // bespoke/vonage.ts:15 (bearerPrefix)
    signatureFormat: "`Authorization: Bearer <jwt>` — a compact HS256 JWT", // bespoke/vonage.ts:1-2
    algorithm: "HS256 (JWT)", // bespoke/vonage.ts:1 · jws.ts:87-90,99-128
    keyDerivation: "registered secret is the account Signature Secret, verbatim UTF-8 HMAC key", // bespoke/vonage.ts:2-4
    signedMessage:
      "the JWT signing input; the body is bound via the `payload_hash` claim (hex SHA-256 of the raw body)", // bespoke/vonage.ts:1-4 · jws-hash-binding.ts:52-60
    signedMessageParts: ["jwt-header", "jwt-payload"],
    timestamp: null, // bespoke/vonage.ts:2 (iat/jti but no nbf/exp) · jws-hash-binding.ts never enforces a window
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // bespoke/vonage.ts:2-3 (no provider-enforced window)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader"],
    quirks: [
      "Delivered as `Authorization: Bearer <jwt>` (the Bearer prefix is stripped before parse).", // bespoke/vonage.ts:1,15
      'HS256 JWT with `iss: "Vonage"` and body bound by the `payload_hash` claim (hex SHA-256).', // bespoke/vonage.ts:1-2
      "Carries iat/jti but no nbf/exp → no provider-enforced replay window.", // bespoke/vonage.ts:2-3
    ],
  },

  monday: {
    slug: "monday",
    archetype: "jwt",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "authorization", // bespoke/monday.ts:16
    signatureFormat: "a BARE compact HS256 JWT in `Authorization` (NO `Bearer ` prefix)", // bespoke/monday.ts:1-2
    algorithm: "HS256 (JWT)", // bespoke/monday.ts:1 · jws.ts:87-90,99-128
    keyDerivation: "registered secret is the app Signing Secret, verbatim UTF-8 HMAC key", // bespoke/monday.ts:4-5 · jws.ts:93-96
    signedMessage:
      "the JWT signing input; the token binds ORIGIN + destination via signed claims (`aud` = the exact endpoint URL) — it carries NO body-hash claim, so the payload bytes are NOT integrity-bound", // bespoke/monday.ts:1-5,35-47
    signedMessageParts: ["jwt-header", "jwt-payload"],
    timestamp: { source: "the JWT `exp` / `iat` claims", format: "seconds" }, // bespoke/monday.ts:49 · jws.ts:139-169
    replayWindow: { enforced: true, toleranceSeconds: 300 }, // bespoke/monday.ts:49 (enforceJwtWindow)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "requestUrl"],
    quirks: [
      "BARE HS256 JWT in `Authorization` — NO `Bearer ` prefix.", // bespoke/monday.ts:1
      "ORIGIN-authenticated only: `aud` (= the exact endpoint URL) is required and matched, but there is NO body-hash claim, so the payload bytes are not integrity-bound (TLS protects them in transit).", // bespoke/monday.ts:1-5,35-47
      "Freshness enforced via `exp` / `iat`.", // bespoke/monday.ts:49
      "UI / personal-token-created webhooks are UNSIGNED (no Authorization header) and unverifiable; only monday-app / OAuth-created webhooks carry the JWT.", // bespoke/monday.ts:7-8
    ],
  },

  jira_connect: {
    slug: "jira_connect",
    archetype: "jwt",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "authorization", // bespoke/jira-connect.ts:24
    signatureValuePrefix: "JWT ", // bespoke/jira-connect.ts:25 (literal scheme word `JWT`)
    signatureFormat:
      "`Authorization: JWT <token>` — a compact HS256 JWT (literal scheme word `JWT`, not `Bearer`)", // bespoke/jira-connect.ts:1-2,25
    algorithm: "HS256 (JWT)", // bespoke/jira-connect.ts:2 · jws.ts:87-90,99-128
    keyDerivation:
      "registered secret is the install `sharedSecret`, verbatim UTF-8 HMAC key (opaque despite looking base64 — do NOT decode)", // bespoke/jira-connect.ts:2-3
    signedMessage:
      "the JWT signing input; the request is bound via the `qsh` claim = hex SHA-256 of `METHOD&canonicalPath&canonicalQuery` — NOT the body", // bespoke/jira-connect.ts:2-4,12-15,56-77,102-123
    signedMessageParts: ["jwt-header", "jwt-payload"],
    timestamp: { source: "the JWT `exp` claim", format: "seconds" }, // bespoke/jira-connect.ts:93-95 · jws.ts:139-169
    replayWindow: { enforced: true, toleranceSeconds: 300 }, // bespoke/jira-connect.ts:94 (enforceJwtWindow; Connect exp ~3 min)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "requestUrl", "method"],
    quirks: [
      "Delivered as `Authorization: JWT <token>` — literal scheme word `JWT`, not `Bearer`.", // bespoke/jira-connect.ts:1,25
      "Request bound via the `qsh` claim = hex SHA-256 of `METHOD&canonicalPath&canonicalQuery` — origin/request-authenticated; the BODY is NOT integrity-bound.", // bespoke/jira-connect.ts:2-4,12-15
      "Canonical query joins repeated values with a LITERAL comma (`,`), not `%2C` (the Jira doc prose is wrong; atlassian-jwt uses `,`).", // bespoke/jira-connect.ts:12-15,41-49
      'A literal `qsh: "context-qsh"` (frontend context token) is deliberately NOT honored for webhook deliveries.', // bespoke/jira-connect.ts:97-101
      "`iss` (tenant clientKey) varies per install and is NOT pinned; the HS256 MAC is the proof. Short exp (~3 min) enforced.", // bespoke/jira-connect.ts:4-6,93-95
      "Distinct from the `atlassian_jira` config row (x-hub-signature raw-body system webhooks).", // bespoke/jira-connect.ts:17-19
    ],
  },

  // ── Runtime-branching (client-verifiable, but request-context — needs method / URL) ───────────────
  twilio: {
    slug: "twilio",
    archetype: "request-context-hmac",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-twilio-signature", // bespoke/twilio.ts:17 · config.ts:1138
    signatureFormat: "base64-encoded HMAC-SHA1 MAC", // bespoke/twilio.ts:47-49 · config.ts:1139-1140
    algorithm: "HMAC-SHA1", // config.ts:1140 (digest "sha1")
    encoding: "base64", // config.ts:1139
    keyDerivation: "registered secret is the Twilio Auth Token, used verbatim as the HMAC key", // config.ts:1136-1143 (makeHmacAdapter)
    signedMessage:
      "TWO runtime modes — FORM: `{fullURL}{sorted form fields concatenated}`; JSON (`?…&bodySHA256=<hex>`): HMAC over the full URL (which carries the signed bodySHA256) AND SHA-256(rawBody) must equal that `bodySHA256`", // bespoke/twilio.ts:1-9,42-79 · config.ts:1141
    signedMessageParts: ["url:full", "sortedFormFields"],
    timestamp: null, // no signed timestamp
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // no window (config.ts:1142)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "requestUrl"],
    quirks: [
      "Two runtime modes selected by the presence of a `bodySHA256` query param — a single HMAC config can't express this.", // bespoke/twilio.ts:1-9
      "FORM mode: HMAC-SHA1(authToken, fullURL + sorted form fields concatenated).", // bespoke/twilio.ts:1-3 · config.ts:1141
      "JSON mode: HMAC-SHA1 over the full URL (which carries the signed `bodySHA256`), AND SHA-256(rawBody) hex must equal that `bodySHA256`.", // bespoke/twilio.ts:4-9,51-79
      "The SDK tries the URL with and without the default port (:443/:80); the adapter mirrors this port-toggle.", // bespoke/twilio.ts:9,19-33
    ],
  },

  contentful: {
    slug: "contentful",
    archetype: "request-context-hmac",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-contentful-signature", // bespoke/contentful.ts:19
    signatureFormat: "lowercase-hex 32-byte HMAC-SHA256 MAC", // bespoke/contentful.ts:10-11,52-54
    algorithm: "HMAC-SHA256", // bespoke/contentful.ts:11 (hmacSha256)
    encoding: "hex", // bespoke/contentful.ts:11,52
    keyDerivation: "registered secret is a 64-char string used verbatim as the UTF-8 HMAC key", // bespoke/contentful.ts:11,111
    signedMessage:
      "a canonical request `METHOD\\nNORMALIZED_PATH\\nHEADERS_SECTION\\nRAW_BODY`, where HEADERS_SECTION is exactly the headers named in `x-contentful-signed-headers` (`key:value`, key lowercased, sorted by key, joined by `;`)", // bespoke/contentful.ts:1-12,83-106
    signedMessageParts: ["method", "url:path", "signed-headers", "body"],
    timestamp: { source: "the `x-contentful-timestamp` header", format: "milliseconds" }, // bespoke/contentful.ts:12,62-64
    replayWindow: { enforced: true, toleranceSeconds: 30 }, // bespoke/contentful.ts:22,62-73 (one-sided 30s TTL; timestamp is a signed header)
    rotation: false,
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "requestUrl", "method", "timestamp"],
    // Names the DYNAMIC set of headers folded into the canonical request; the adapter fails MALFORMED
    // without it, and each header it names must be supplied too.
    signedHeaders: ["x-contentful-signed-headers"], // bespoke/contentful.ts:57-59,88-97
    quirks: [
      "The signed message's header section is DYNAMIC: `x-contentful-signed-headers` lists which headers are folded in, so the canonical string shape varies per request.", // bespoke/contentful.ts:1-8
      "Canonical = `METHOD\\nNORMALIZED_PATH\\nHEADERS_SECTION\\nRAW_BODY`; signed headers are `key:value`, key lowercased+trimmed, sorted by key, joined by `;` (the signed-headers HEADER itself uses `,`).", // bespoke/contentful.ts:6-12,88-106
      "One-sided 30-second TTL against `x-contentful-timestamp` (milliseconds); the timestamp is itself a signed header, so replay is also bound in the signature.", // bespoke/contentful.ts:11-12,62-73
    ],
  },

  plivo: {
    slug: "plivo",
    archetype: "request-context-hmac",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-plivo-signature-v3", // bespoke/plivo.ts:22
    additionalSignatureHeaders: ["x-plivo-signature-ma-v3"], // bespoke/plivo.ts:23,67 (main-account token)
    signatureFormat:
      "standard-base64 HMAC-SHA256 MAC; each header value may be a COMMA-LIST of signatures (match any)", // bespoke/plivo.ts:14-15,67-75
    algorithm: "HMAC-SHA256", // bespoke/plivo.ts:14,109 (hmacSha256)
    encoding: "base64", // bespoke/plivo.ts:14,94-97
    keyDerivation: "registered secret is the Plivo Auth Token, verbatim UTF-8 HMAC key", // bespoke/plivo.ts:14,109
    signedMessage:
      "`{base_url}.{nonce}` — base_url = `scheme://host[:port]/path` plus URL-decoded sorted query (GET) and, for POST, sorted form fields glued conditionally with `?`/`.`; nonce = `X-Plivo-Signature-V3-Nonce`", // bespoke/plivo.ts:1-16,31-56,92
    signedMessageParts: [
      "url:base",
      "sorted-query",
      "sorted-form-fields",
      "header:x-plivo-signature-v3-nonce",
    ],
    timestamp: null, // bespoke/plivo.ts:15 (no replay window; the nonce is not a timestamp)
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // bespoke/plivo.ts:15,116
    rotation: true, // bespoke/plivo.ts:14-15,65-75 (two headers, each a comma-list; match-any)
    clientVerifiable: true,
    verifierInputs: ["secret", "payload", "signatureHeader", "requestUrl", "method"],
    // The nonce is a request HEADER folded into the signed message; absent it the adapter returns
    // MISSING_HEADER, so the verifier MUST collect it.
    signedHeaders: ["x-plivo-signature-v3-nonce"], // bespoke/plivo.ts:24,60-63
    quirks: [
      "Signed string is a stateful, conditionally-glued mix of URL, sorted query, and (for POST) sorted form body — 4 POST glue cases (`…?Q.B`, `…?Q`, `…?B`, `…`).", // bespoke/plivo.ts:1-16
      "message = `base_url` + `.` + nonce (`X-Plivo-Signature-V3-Nonce`).", // bespoke/plivo.ts:13,92
      "Two headers — `X-Plivo-Signature-V3` (account token) and `X-Plivo-Signature-Ma-V3` (main-account token) — sign the SAME base string; each value may be a comma-list; match ANY.", // bespoke/plivo.ts:14-15,65-75
      "POST form fields joined as `key`+`value` (NO `=`) with empty separator; query joined `key=value` by `&`.", // bespoke/plivo.ts:9-11,41-55
      "No replay window.", // bespoke/plivo.ts:15
    ],
  },

  // ── Remote-fetch (NOT client-verifiable — needs a third-party JWKS/cert fetch at verify time) ─────
  kinde: {
    slug: "kinde",
    archetype: "remote-fetch",
    source: "bespoke",
    signatureLocation: "json-body", // the request BODY is the JWS; there is no signature header
    signatureHeader: null, // bespoke/kinde.ts:118 (signatureHeader "")
    signatureFormat:
      "the request BODY is an RS256 compact JWS (content-type `application/jwt`); there is NO signature header", // bespoke/kinde.ts:1-6,48
    algorithm: "RSA-PKCS1 (SHA-256) — RS256 JWT", // bespoke/kinde.ts:1,56 · asymmetric.ts:74-91
    keyDerivation:
      "registered \"secret\" is the operator's Kinde issuer URL; the RSA public key is fetched by `kid` from THAT issuer's JWKS (`/.well-known/jwks.json`, host-pinned to the registered issuer)", // bespoke/kinde.ts:1-7,73-100
    signedMessage:
      "the JWT signing input `base64url(header).base64url(payload)`; the signed payload IS the event, so verifying the JWS verifies the body", // bespoke/kinde.ts:5-6,104
    signedMessageParts: ["jwt-header", "jwt-payload"],
    timestamp: { source: "the JWT `exp` / `nbf` / `iat` claims (when present)", format: "seconds" }, // bespoke/kinde.ts:110 · jws.ts:139-169
    replayWindow: { enforced: true, toleranceSeconds: 300 }, // bespoke/kinde.ts:110 (enforceJwtWindow on numeric exp/nbf/iat)
    rotation: false,
    clientVerifiable: false, // needs a third-party JWKS fetch
    verifierInputs: [],
    quirks: [
      "The request BODY is an RS256 JWT (content-type `application/jwt`) — there is NO signature header; the signed payload IS the event.", // bespoke/kinde.ts:1-6
      "Not client-verifiable: needs a JWKS fetch. Registered \"secret\" is the operator's Kinde issuer URL; the JWKS host is pinned to that issuer, so a forged `iss` can't redirect the fetch.", // bespoke/kinde.ts:1-7,73-95
      "Key fetch is fail-soft (KEY_FETCH_FAILED → captured unverified, never dropped).", // bespoke/kinde.ts:6-7,96-98
      "alg pinned to RS256; freshness enforced on any numeric exp/nbf/iat the token carries (claims optional).", // bespoke/kinde.ts:56,107-111
    ],
  },

  paypal: {
    slug: "paypal",
    archetype: "remote-fetch",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "paypal-transmission-sig", // bespoke/paypal.ts:16
    signatureFormat: "base64-encoded RSA signature", // bespoke/paypal.ts:1-3,42
    algorithm: "RSA-PKCS1 (SHA-256)", // bespoke/paypal.ts:1,96 · asymmetric.ts:41-68
    encoding: "base64", // bespoke/paypal.ts:1,42
    keyDerivation:
      'the public key is an X.509 certificate FETCHED from `PAYPAL-CERT-URL` (host-pinned to PayPal cert hosts + a required cert path); the registered "secret" is the operator\'s configured webhook id', // bespoke/paypal.ts:1-7,51-88
    signedMessage:
      "`{PAYPAL-TRANSMISSION-ID}|{PAYPAL-TRANSMISSION-TIME}|{webhookId}|{crc32(rawBody)}` (pipe-joined; crc32 is the unsigned IEEE CRC-32 of the raw body as a decimal string)", // bespoke/paypal.ts:1-4,90-95
    signedMessageParts: [
      "header:paypal-transmission-id",
      "header:paypal-transmission-time",
      "secret:webhook-id",
      "body:crc32",
    ],
    timestamp: {
      source: "the `paypal-transmission-time` header (part of the signed string)",
      format: "datetime",
    }, // bespoke/paypal.ts:18,90-95
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // no window check in bespoke/paypal.ts
    rotation: false,
    clientVerifiable: false, // needs a third-party cert fetch
    verifierInputs: [],
    quirks: [
      "Not client-verifiable: the RSA public key is an X.509 cert fetched from the message-supplied `PAYPAL-CERT-URL`, host-pinned to `api.paypal.com`/`api.sandbox.paypal.com` + the documented cert path.", // bespoke/paypal.ts:1-7,51-88
      "Signed string is `TRANSMISSION-ID | TRANSMISSION-TIME | webhookId | crc32(body)` — the body is bound via its CRC-32 (unsigned IEEE, as a decimal string), not a full hash.", // bespoke/paypal.ts:1-4,90-95
      'The registered "secret" is the operator\'s configured webhook id (from the PayPal dashboard).', // bespoke/paypal.ts:5-6
      "Cert fetch is cached (24h) + fail-soft (KEY_FETCH_FAILED).", // bespoke/paypal.ts:20,75-83
    ],
  },

  aws_sns: {
    slug: "aws_sns",
    archetype: "remote-fetch",
    source: "bespoke",
    signatureLocation: "json-body", // the signature is a `Signature` field in the JSON body
    signatureHeader: null, // bespoke/aws-sns.ts:144 (signatureHeader "")
    signatureFormat: "a base64 `Signature` field IN the JSON body (no signature header)", // bespoke/aws-sns.ts:1-6,71-72
    algorithm: "RSA-PKCS1 (SHA-1 for SignatureVersion 1, SHA-256 for version 2)", // bespoke/aws-sns.ts:3-4,135 · asymmetric.ts:41-59
    encoding: "base64", // bespoke/aws-sns.ts:71-72,93
    keyDerivation:
      "the public key is an X.509 cert FETCHED from the body's `SigningCertURL` (host-pinned to `sns.<region>.amazonaws.com`, path ending `.pem`); the registered \"secret\" is the operator's TopicArn", // bespoke/aws-sns.ts:1-11,20-21,87-131
    signedMessage:
      "a canonical `Key\\nValue\\n` string of the present signable fields in a fixed per-type order (Notification vs (Un)SubscribeConfirmation)", // bespoke/aws-sns.ts:22-45,134
    signedMessageParts: ["canonical:key-value-fields", "body"],
    timestamp: {
      source: "the body `Timestamp` field (a signed canonical field)",
      format: "datetime",
    }, // bespoke/aws-sns.ts:25,37-45
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // no window check in bespoke/aws-sns.ts
    rotation: false,
    clientVerifiable: false, // needs a third-party cert fetch
    verifierInputs: [],
    quirks: [
      "Not client-verifiable: the RSA public key is an X.509 cert fetched from the body's `SigningCertURL`, host-pinned to `sns.<region>.amazonaws.com` (anchored regex — a substring check is the documented CVE-class bug) with a `.pem` path.", // bespoke/aws-sns.ts:1-6,20-21,108-114
      "The signature is a base64 field IN the JSON body — there is no signature header.", // bespoke/aws-sns.ts:1-6,71-72
      "SignatureVersion 1 = SHA-1 (still AWS's default), version 2 = SHA-256.", // bespoke/aws-sns.ts:3-4,135
      "Signed over a canonical `Key\\nValue\\n` string of only the PRESENT signable fields in a fixed per-type order (a Notification omits SubscribeURL+Token).", // bespoke/aws-sns.ts:22-45
      'Registered "secret" is the operator\'s TopicArn (binds a message to their topic); (Un)SubscribeConfirmation are surface-only — the SubscribeURL is never auto-fetched (SSRF guard).', // bespoke/aws-sns.ts:6-11,87-91
    ],
  },

  plaid: {
    slug: "plaid",
    archetype: "remote-fetch",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "plaid-verification", // bespoke/plaid.ts:17
    signatureFormat: "a compact ES256 JWT", // bespoke/plaid.ts:1-2,78
    algorithm: "ECDSA (P-256, SHA-256) — ES256 JWT", // bespoke/plaid.ts:1,78 · asymmetric.ts:154-177
    keyDerivation:
      "the verification key is Plaid's EC public key fetched by `kid` from an AUTHENTICATED endpoint (`POST /webhook_verification_key/get` with the operator's client_id + secret); the registered \"secret\" is a JSON blob `{environment, client_id, secret}`", // bespoke/plaid.ts:1-7,27-46,104-113
    signedMessage:
      "the JWT signing input; the body is bound via the `request_body_sha256` claim (hex SHA-256 of the raw body)", // bespoke/plaid.ts:1-2,127-131
    signedMessageParts: ["jwt-header", "jwt-payload"],
    timestamp: { source: "the JWT `iat` claim", format: "seconds" }, // bespoke/plaid.ts:133 · jws.ts:139-169
    replayWindow: { enforced: true, toleranceSeconds: 300 }, // bespoke/plaid.ts:133 (enforceJwtWindow)
    rotation: false,
    clientVerifiable: false, // needs an authenticated third-party key fetch
    verifierInputs: [],
    quirks: [
      "Not client-verifiable: the EC public key is fetched by `kid` from an AUTHENTICATED Plaid endpoint (`POST /webhook_verification_key/get`) using the operator's client_id + secret — the only remote-fetch provider needing credentials.", // bespoke/plaid.ts:1-7,104-113
      'Registered "secret" is a JSON blob `{"environment":"production"|"sandbox","client_id":…,"secret":…}`.', // bespoke/plaid.ts:4-7,21-46
      "ES256 JWT in `Plaid-Verification`; body bound by the `request_body_sha256` claim; alg pinned ES256.", // bespoke/plaid.ts:1-2,78,127-131
      "iat freshness enforced; the key fetch is host-pinned + cached (24h) + fail-soft.", // bespoke/plaid.ts:6-7,133
    ],
  },

  ebay: {
    slug: "ebay",
    archetype: "remote-fetch",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-ebay-signature", // bespoke/ebay.ts:23
    signatureFormat:
      "base64(JSON `{alg, kid, signature, digest}`) where `signature` is a base64 DER ECDSA signature over the raw body", // bespoke/ebay.ts:1-6,61-78
    algorithm: "ECDSA (P-256, SHA-1) — SHA1withECDSA", // bespoke/ebay.ts:1-4,184 · asymmetric.ts:123-147
    encoding: "base64", // bespoke/ebay.ts:1,63-77
    keyDerivation:
      "eBay's public key is fetched by `kid` from an AUTHENTICATED endpoint (needs a minted client-credentials app token first); the registered \"secret\" is the operator's eBay app creds JSON `{clientId, clientSecret, env}`", // bespoke/ebay.ts:1-11,39-54,142-183
    signedMessage: "the RAW request body (ECDSA P-256 over SHA-1)", // bespoke/ebay.ts:1-6,184
    signedMessageParts: ["body"],
    timestamp: null, // no signed timestamp / window in bespoke/ebay.ts
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // no window check
    rotation: false,
    clientVerifiable: false, // needs a token mint + authenticated key fetch
    verifierInputs: [],
    quirks: [
      "Not client-verifiable: needs (1) minting a client-credentials app token, then (2) fetching eBay's public key by `kid` with that Bearer token — the only adapter that mints a token to fetch the key.", // bespoke/ebay.ts:1-11,142-183
      "`SHA1withECDSA` — ECDSA P-256 over SHA-1 (the signature header's `digest` field is literally SHA1); the DER signature is converted to IEEE-P1363 r||s.", // bespoke/ebay.ts:1-4,121,184 · asymmetric.ts:123-147
      "Signature ships as base64(JSON `{alg, kid, signature, digest}`) in `X-EBAY-SIGNATURE`; the signature is over the RAW body.", // bespoke/ebay.ts:1-6,61-78
      'Registered "secret" is the operator\'s eBay app creds JSON `{clientId, clientSecret, env}`.', // bespoke/ebay.ts:7-9,39-54
      "Verified against self-generated vectors, NOT yet against a live eBay notification.", // bespoke/ebay.ts:12-14
    ],
  },

  constant_contact: {
    slug: "constant_contact",
    archetype: "remote-fetch",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-ctct-webhook-sig", // bespoke/constant-contact.ts:18
    signatureFormat:
      "a DETACHED (RFC 7515/7797) RS256 compact JWS `<b64url(header)>..<b64url(signature)>` with an EMPTY payload segment", // bespoke/constant-contact.ts:1-9,29-45
    algorithm: "RSA-PKCS1 (SHA-256) — RS256 detached JWS", // bespoke/constant-contact.ts:1,107 · asymmetric.ts:74-91
    keyDerivation:
      "the signing key comes from Constant Contact's PUBLIC JWKS (developer.constantcontact.com), which carries NO `kid`, so every RSA signing key is tried; there is no per-endpoint secret — a registered secret is only an enable-marker", // bespoke/constant-contact.ts:5-9,70-88,118-121
    signedMessage:
      'RFC 7797 unencoded-payload signing input `ASCII(b64url(protectedHeader)) + "." + rawBody` — the protected header carries `b64:false, crit:["b64"], ts:<unix>`', // bespoke/constant-contact.ts:1-9,108-115,126-127
    signedMessageParts: ["jws-protected-header", "body"],
    timestamp: { source: "the signed `ts` field in the JWS protected header", format: "seconds" }, // bespoke/constant-contact.ts:12,143
    replayWindow: { enforced: true, toleranceSeconds: 300 }, // bespoke/constant-contact.ts:52-68,143 (signed `ts`, two-sided window)
    rotation: false,
    clientVerifiable: false, // needs a third-party JWKS fetch
    verifierInputs: [],
    quirks: [
      "Not client-verifiable: the RS256 signing key comes from Constant Contact's PUBLIC JWKS (host-pinned to developer.constantcontact.com), fetched + cached + fail-soft.", // bespoke/constant-contact.ts:5-9,129-137
      'DETACHED JWS (RFC 7515 + RFC 7797, `b64:false`): the payload segment is EMPTY and the signing input is `ASCII(b64url(header)) + "." + rawBody` (unencoded body).', // bespoke/constant-contact.ts:1-8,108-127
      "The JWKS carries NO `kid`, so every RSA signing key is tried; there is NO per-endpoint secret — a registered secret is only an enable-marker (its value is ignored).", // bespoke/constant-contact.ts:5-8,70-88,118-121
      "The signed `ts` (unix) in the protected header drives a two-sided replay window; `crit` must be exactly `[b64]`.", // bespoke/constant-contact.ts:52-68,108-115,143
      "Unit-verified against self-generated vectors, NOT yet against a live Constant Contact webhook.", // bespoke/constant-contact.ts:8-9
    ],
  },

  // ── Token / NON-crypto (NOT verifiable — a shared secret compared for equality, no payload signature) ──
  gitlab: {
    slug: "gitlab",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-gitlab-token", // bespoke/token-auth-providers.ts:14
    signatureFormat:
      'the operator\'s "Secret token" sent verbatim in a fixed header (plain equality)', // bespoke/token-auth-providers.ts:11-16 · token-auth.ts:130-137
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.gitlab (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      'GitLab\'s "Secret token" in DEFAULT mode: plain equality on `X-Gitlab-Token`, not its opt-in HMAC.', // bespoke/token-auth-providers.ts:11-16
    ],
  },

  telegram: {
    slug: "telegram",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "x-telegram-bot-api-secret-token", // bespoke/token-auth-providers.ts:76
    signatureFormat:
      "the operator's `setWebhook` secret sent verbatim in a fixed header (plain equality)", // bespoke/token-auth-providers.ts:71-77
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.telegram (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "Telegram sends the operator's `setWebhook` secret in a FIXED header.", // bespoke/token-auth-providers.ts:71-77
    ],
  },

  microsoft_graph: {
    slug: "microsoft_graph",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "json-body", // the token rides in a JSON body field, not a header
    signatureHeader: null, // bespoke/token-auth-providers.ts:24 (signatureHeader "")
    signatureFormat:
      "the operator's subscription secret carried in the JSON body field `value[0].clientState`", // bespoke/token-auth-providers.ts:18-25 · token-auth.ts:71-84
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.microsoft_graph (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "The subscription secret rides in the JSON body `value[0].clientState`; batched deliveries share it, so the first element is checked.", // bespoke/token-auth-providers.ts:18-25
    ],
  },

  chargebee: {
    slug: "chargebee",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "authorization", // bespoke/token-auth-providers.ts:31
    signatureFormat:
      "`Authorization: Basic base64(user:pass)` compared to the registered `user:pass`", // bespoke/token-auth-providers.ts:26-32 · token-auth.ts:86-92
    algorithm: "HTTP Basic",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.chargebee (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "HTTP Basic auth (`Authorization: Basic b64(user:pass)`); registered secret is the plain `user:pass`.", // bespoke/token-auth-providers.ts:26-32
    ],
  },

  postmark: {
    slug: "postmark",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "authorization", // bespoke/token-auth-providers.ts:36
    signatureFormat:
      "`Authorization: Basic base64(user:pass)` compared to the registered `user:pass`", // bespoke/token-auth-providers.ts:33-38 · token-auth.ts:86-92
    algorithm: "HTTP Basic",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.postmark (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "HTTP Basic auth (`Authorization: Basic b64(user:pass)`); registered secret is the plain `user:pass`.", // bespoke/token-auth-providers.ts:33-38
    ],
  },

  sparkpost: {
    slug: "sparkpost",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "authorization", // bespoke/token-auth-providers.ts:41
    signatureFormat:
      "`Authorization: Basic base64(user:pass)` compared to the registered `user:pass`", // bespoke/token-auth-providers.ts:39-44 · token-auth.ts:86-92
    algorithm: "HTTP Basic",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.sparkpost (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "HTTP Basic auth (`Authorization: Basic b64(user:pass)`); registered secret is the plain `user:pass`.", // bespoke/token-auth-providers.ts:39-44
    ],
  },

  mixpanel: {
    slug: "mixpanel",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: "authorization", // bespoke/token-auth-providers.ts:85
    signatureFormat:
      "`Authorization: Basic base64(user:pass)` compared to the registered `user:pass`", // bespoke/token-auth-providers.ts:81-86 · token-auth.ts:86-92
    algorithm: "HTTP Basic",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.mixpanel (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "HTTP Basic auth on Mixpanel COHORT-SYNC webhooks; registered secret is the plain `user:pass`.", // bespoke/token-auth-providers.ts:78-86
      "Scope: cohort-sync only. Mixpanel's separate event-export/pipeline webhooks DO sign with `x-mixpanel-signature` HMAC-SHA1 — a different product; don't upgrade this row to it.", // bespoke/token-auth-providers.ts:79-81
    ],
  },

  okta: {
    slug: "okta",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: null, // operator-configured header NAME; bespoke/token-auth-providers.ts:50 (signatureHeader "")
    signatureFormat:
      "an operator-CHOSEN header carries the token; the registered secret is a JSON `{header, token}`", // bespoke/token-auth-providers.ts:45-51 · token-auth.ts:98-128
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.okta (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "The signature header NAME is operator-configured (registered secret is JSON `{header, token}`), so there is no fixed header to pin.", // bespoke/token-auth-providers.ts:45-51
    ],
  },

  bigcommerce: {
    slug: "bigcommerce",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: null, // operator-configured header NAME; bespoke/token-auth-providers.ts:56 (signatureHeader "")
    signatureFormat:
      "an operator-CHOSEN header carries the token; the registered secret is a JSON `{header, token}`", // bespoke/token-auth-providers.ts:52-57 · token-auth.ts:98-128
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.bigcommerce (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "The signature header NAME is operator-configured (registered secret is JSON `{header, token}`), so there is no fixed header to pin.", // bespoke/token-auth-providers.ts:52-57
    ],
  },

  datadog: {
    slug: "datadog",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: null, // operator-configured header NAME; bespoke/token-auth-providers.ts:62 (signatureHeader "")
    signatureFormat:
      "an operator-CHOSEN header carries the token; the registered secret is a JSON `{header, token}`", // bespoke/token-auth-providers.ts:58-63 · token-auth.ts:98-128
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.datadog (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "The signature header NAME is operator-configured (registered secret is JSON `{header, token}`), so there is no fixed header to pin.", // bespoke/token-auth-providers.ts:58-63
    ],
  },

  brevo: {
    slug: "brevo",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: null, // operator-configured header NAME; bespoke/token-auth-providers.ts:68 (signatureHeader "")
    signatureFormat:
      "an operator-CHOSEN header carries the token; the registered secret is a JSON `{header, token}`", // bespoke/token-auth-providers.ts:64-69 · token-auth.ts:98-128
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.brevo (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "The signature header NAME is operator-configured (registered secret is JSON `{header, token}`), so there is no fixed header to pin.", // bespoke/token-auth-providers.ts:64-69
    ],
  },

  new_relic: {
    slug: "new_relic",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: null, // operator-configured header NAME; bespoke/token-auth-providers.ts:95 (signatureHeader "")
    signatureFormat:
      "an operator-CHOSEN header carries the token; the registered secret is a JSON `{header, token}`", // bespoke/token-auth-providers.ts:91-96 · token-auth.ts:98-128
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.new_relic (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "The signature header NAME is operator-configured (registered secret is JSON `{header, token}`), so there is no fixed header to pin.", // bespoke/token-auth-providers.ts:91-96
    ],
  },

  fillout: {
    slug: "fillout",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: null, // operator-configured header NAME; bespoke/token-auth-providers.ts:101 (signatureHeader "")
    signatureFormat:
      "an operator-CHOSEN header carries the token; the registered secret is a JSON `{header, token}`", // bespoke/token-auth-providers.ts:97-102 · token-auth.ts:98-128
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.fillout (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "The signature header NAME is operator-configured (registered secret is JSON `{header, token}`), so there is no fixed header to pin.", // bespoke/token-auth-providers.ts:97-102
      "Scope: Fillout's FORM-submission webhook is custom-header only. Its separate database/tables webhook product signs with an `X-Webhook-Signature` HMAC-SHA256 — a different product; don't conflate them.", // bespoke/token-auth-providers.ts:88-90
    ],
  },

  zapier: {
    slug: "zapier",
    archetype: "token",
    source: "bespoke",
    signatureLocation: "header",
    signatureHeader: null, // operator-configured header NAME; bespoke/token-auth-providers.ts:107 (signatureHeader "")
    signatureFormat:
      "an operator-CHOSEN header carries the token; the registered secret is a JSON `{header, token}`", // bespoke/token-auth-providers.ts:103-108 · token-auth.ts:98-128
    algorithm: "shared static token",
    keyDerivation: "n/a",
    signedMessage: "n/a — a shared secret compared for equality, not a payload signature",
    signedMessageParts: [],
    timestamp: null,
    replayWindow: { enforced: false, toleranceSeconds: 300 }, // PROVIDER_TOLERANCE_SECONDS.zapier (never enforced)
    rotation: false,
    clientVerifiable: false,
    verifierInputs: [],
    quirks: [
      "Authenticated, not cryptographically verified — there is no payload signature.", // bespoke/token-auth.ts:1-4
      "The signature header NAME is operator-configured (registered secret is JSON `{header, token}`), so there is no fixed header to pin.", // bespoke/token-auth-providers.ts:103-108
    ],
  },
};

/**
 * Code-pins for every bespoke recipe with a NON-NULL signatureHeader: the exact header literal, and the
 * adapter file (relative to `packages/webhooks-spec/src/adapters/`) whose source contains that literal. A
 * drift test can read each file and grep-assert the header string still appears — so a renamed header in an
 * adapter fails the pin instead of silently diverging from the recipe. Slugs whose header is null (kinde,
 * aws_sns, microsoft_graph) or operator-configured (okta, bigcommerce, datadog, brevo, new_relic, fillout,
 * zapier) are intentionally omitted — there is no fixed literal to pin.
 */
export const BESPOKE_HEADER_PINS: Record<string, { header: string; file: string }> = {
  discord: { header: "x-signature-ed25519", file: "bespoke/discord.ts" },
  telnyx: { header: "telnyx-signature-ed25519", file: "bespoke/telnyx.ts" },
  sendgrid: { header: "x-twilio-email-event-webhook-signature", file: "bespoke/sendgrid.ts" },
  wise: { header: "x-signature-sha256", file: "bespoke/wise.ts" },
  keygen: { header: "keygen-signature", file: "bespoke/keygen.ts" },
  messagebird: { header: "messagebird-signature-jwt", file: "bespoke/messagebird.ts" },
  netlify: { header: "x-webhook-signature", file: "bespoke/netlify.ts" },
  vonage: { header: "authorization", file: "bespoke/vonage.ts" },
  monday: { header: "authorization", file: "bespoke/monday.ts" },
  jira_connect: { header: "authorization", file: "bespoke/jira-connect.ts" },
  twilio: { header: "x-twilio-signature", file: "bespoke/twilio.ts" },
  contentful: { header: "x-contentful-signature", file: "bespoke/contentful.ts" },
  plivo: { header: "x-plivo-signature-v3", file: "bespoke/plivo.ts" },
  paypal: { header: "paypal-transmission-sig", file: "bespoke/paypal.ts" },
  plaid: { header: "plaid-verification", file: "bespoke/plaid.ts" },
  ebay: { header: "x-ebay-signature", file: "bespoke/ebay.ts" },
  constant_contact: { header: "x-ctct-webhook-sig", file: "bespoke/constant-contact.ts" },
  gitlab: { header: "x-gitlab-token", file: "bespoke/token-auth-providers.ts" },
  telegram: { header: "x-telegram-bot-api-secret-token", file: "bespoke/token-auth-providers.ts" },
  chargebee: { header: "authorization", file: "bespoke/token-auth-providers.ts" },
  postmark: { header: "authorization", file: "bespoke/token-auth-providers.ts" },
  sparkpost: { header: "authorization", file: "bespoke/token-auth-providers.ts" },
  mixpanel: { header: "authorization", file: "bespoke/token-auth-providers.ts" },
};
