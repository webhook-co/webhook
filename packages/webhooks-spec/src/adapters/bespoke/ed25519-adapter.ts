// A factory for Ed25519 webhook providers: the signature is Ed25519 over `timestamp (+ separator) + body`,
// the registered "secret" is the provider's PUBLIC key, and the only per-provider variation is the header
// names, the signature/key encodings, and the timestamp↔body separator. Discord (hex key + hex sig, no
// separator) and Telnyx (base64 key + base64 sig, `|` separator) are thin configs over this.
//
// The signed timestamp is bound INTO the message (so it can't be tampered), but no replay-age WINDOW is
// enforced here — the signature is the authenticity guarantee; downstream dedupe handles replay. Fail-closed
// throughout (the verifyEd25519 primitive never throws).

import { b64ToBytes, concatBytes, hexToBytes, utf8Encoder } from "../../bytes";
import type { VerifyAdapter, VerifyInput } from "../../adapter";
import { verificationFailed, verificationOk, type VerificationResult } from "../../verification";
import { verifyEd25519 } from "../asymmetric";
import type { Provider } from "../config";
import { findHeader } from "../shared";

type ByteEncoding = "hex" | "base64";
const DECODERS: Readonly<Record<ByteEncoding, (s: string) => Uint8Array | null>> = {
  hex: hexToBytes,
  base64: b64ToBytes,
};

export interface Ed25519AdapterConfig {
  readonly slug: Provider;
  /** The header carrying the Ed25519 signature. */
  readonly signatureHeader: string;
  /** The header carrying the signed timestamp. */
  readonly timestampHeader: string;
  /** How the signature is encoded on the wire (Discord hex, Telnyx base64). */
  readonly signatureEncoding: ByteEncoding;
  /** How the registered 32-byte public key is encoded (Discord hex, Telnyx base64). */
  readonly keyEncoding: ByteEncoding;
  /** A literal inserted between timestamp and body in the signed message ("" Discord, "|" Telnyx). */
  readonly separator: string;
  /**
   * Replay tolerance (seconds) — ADVISORY metadata only, sourced from the skew table for uniformity. This
   * adapter does NOT enforce an age window: the signed timestamp is bound into the message (so it can't be
   * altered without breaking the signature), but its freshness is intentionally not checked — the signature
   * is the authenticity guarantee and downstream dedupe handles replay.
   */
  readonly toleranceSeconds: number;
}

export function makeEd25519Adapter(config: Ed25519AdapterConfig): VerifyAdapter {
  const { slug, signatureHeader, timestampHeader, signatureEncoding, keyEncoding, separator } =
    config;
  const decodeSig = DECODERS[signatureEncoding];
  const decodeKey = DECODERS[keyEncoding];

  async function verify(input: VerifyInput): Promise<VerificationResult> {
    const sigRaw = findHeader(input.headers, signatureHeader);
    if (sigRaw === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: signatureHeader, scheme: slug });
    }
    const timestamp = findHeader(input.headers, timestampHeader);
    if (timestamp === undefined) {
      return verificationFailed({ code: "MISSING_HEADER", header: timestampHeader, scheme: slug });
    }
    const signature = decodeSig(sigRaw);
    if (signature === null || signature.length !== 64) {
      return verificationFailed({
        code: "MALFORMED_SIGNATURE",
        detail: "signature is not a 64-byte ed25519 signature",
        scheme: slug,
      });
    }

    // message = timestamp (+ separator) followed by the EXACT raw body bytes.
    const message = concatBytes(utf8Encoder.encode(`${timestamp}${separator}`), input.rawBody);

    let sawUsableKey = false;
    for (let i = 0; i < input.secrets.length; i++) {
      const key = decodeKey(input.secrets[i]!);
      if (key === null || key.length !== 32) continue; // not a usable Ed25519 public key
      sawUsableKey = true;
      if (await verifyEd25519(key, message, signature)) {
        return verificationOk(`secret_${i}`, slug);
      }
    }
    if (!sawUsableKey) return verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 0 });
    return verificationFailed({ code: "SIGNATURE_MISMATCH" });
  }

  return { scheme: slug, signatureHeader, toleranceSeconds: config.toleranceSeconds, verify };
}
