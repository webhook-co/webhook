// Standard Webhooks SEND-side signer — the counterpart to standardWebhooksAdapter (the receiver).
// The signed content is `${id}.${timestamp}.${body}` (HMAC-SHA256, base64, `whsec_`+base64 secret,
// `webhook-signature: v1,<sig>` space-delimited for rotation), byte-identical to what the verifier
// accepts. Do not hand-roll a scheme (ADR-0008 / AGENTS.md): the message assembly + secret decoding
// reuse the SAME helpers the verify path uses (toStandardWebhooksCandidates, hmacSha256), and
// sign.test.ts pins it with the published KAT + a round-trip through standardWebhooksAdapter.verify.

import { toStandardWebhooksCandidates } from "./adapters/shared";
import { bytesToB64, concatBytes, hmacSha256, utf8Encoder } from "./bytes";

// The canonical Standard Webhooks v1 header names. The receive-side standardWebhooksConfig builds the
// identical names from prefix "webhook"; kept as named constants so producer + consumer can't drift.
export const WEBHOOK_ID_HEADER = "webhook-id";
export const WEBHOOK_TIMESTAMP_HEADER = "webhook-timestamp";
export const WEBHOOK_SIGNATURE_HEADER = "webhook-signature";

const SIGNATURE_VERSION = "v1";
/** Signing-secret entropy: 256 bits, base64-encoded after the `whsec_` tag. */
const SECRET_BYTES = 32;

export interface SignStandardWebhooksInput {
  /** The unique message id — the receiver's idempotency key (`webhook-id`). Mint a fresh one per
   *  delivery so an intentional redelivery is not deduped as a stale duplicate. */
  readonly id: string;
  /** Unix seconds (`webhook-timestamp`); the receiver enforces a replay window around it. */
  readonly timestamp: number;
  /** The exact body bytes being delivered — signed verbatim, never a re-encoded copy. */
  readonly body: Uint8Array;
  /** Active (+ retiring) `whsec_` secrets, newest first; each yields one space-delimited `v1` sig. */
  readonly secrets: readonly string[];
}

export interface StandardWebhooksHeaders {
  readonly "webhook-id": string;
  readonly "webhook-timestamp": string;
  readonly "webhook-signature": string;
}

/** Mint a fresh Standard Webhooks signing secret: `whsec_` + base64(32 CSPRNG bytes). */
export function generateSigningSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  return `whsec_${bytesToB64(raw)}`;
}

/**
 * Produce the Standard Webhooks v1 signing headers for `body`. The signed content is
 * `${id}.${timestamp}.${body}` (id/timestamp UTF-8, body verbatim) — byte-identical to what
 * `standardWebhooksAdapter` verifies. Each usable secret contributes one `v1,<base64(HMAC-SHA256)>`
 * entry; multiple entries are space-delimited (zero-downtime rotation: current + retiring). STRICT:
 * N secrets in -> N signatures out, or throw — throws if no secret is supplied OR if ANY supplied
 * secret is not usable key material. A misconfigured signer must fail loudly, and a silently-dropped
 * (e.g. retiring) secret must never produce a delivery that receivers pinned to it then reject.
 */
export async function signStandardWebhooks(
  input: SignStandardWebhooksInput,
): Promise<StandardWebhooksHeaders> {
  if (input.secrets.length === 0) {
    throw new Error("signStandardWebhooks: no signing secret provided");
  }
  const candidates = toStandardWebhooksCandidates(input.secrets);
  // STRICT: N secrets in -> N signatures out, or throw. toStandardWebhooksCandidates silently drops a
  // malformed secret (right for the verify path, which tries every candidate); for SIGNING that would
  // emit fewer signatures than supplied, so a receiver still pinned to a dropped (e.g. retiring) secret
  // rejects every delivery while the sender sees success — a silent partial-rotation failure. Fail loud.
  if (candidates.length !== input.secrets.length) {
    throw new Error(
      "signStandardWebhooks: one or more signing secrets are not usable whsec_ secrets",
    );
  }
  const message = concatBytes(utf8Encoder.encode(`${input.id}.${input.timestamp}.`), input.body);
  const signatures = await Promise.all(
    candidates.map(
      async (c) => `${SIGNATURE_VERSION},${bytesToB64(await hmacSha256(c.bytes, message))}`,
    ),
  );
  return {
    "webhook-id": input.id,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": signatures.join(" "),
  };
}
