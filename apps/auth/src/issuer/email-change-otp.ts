import { importHmacKey, timingSafeEqual, utf8Encoder } from "@webhook-co/shared/bytes";

// The step-up OTP primitives for the email-change ceremony. A 6-digit code is sent to the user's CURRENT
// email (proving control of the address on record); only its keyed HASH is stored, and it is re-verified at
// commit. Pure + dependency-injected so the whole thing is unit-testable with no crypto mocks.

const OTP_DIGITS = 6;
const OTP_CEIL = 1_000_000; // 10^6 — the number of 6-digit codes
// The largest multiple of OTP_CEIL that fits in a u32. Reject draws at or above it so `% OTP_CEIL` is uniform
// (modulo of a raw u32 would bias the low ~4.3% of codes). 2^32 = 4_294_967_296.
const REJECT_AT = Math.floor(0xffffffff / OTP_CEIL) * OTP_CEIL;

/**
 * A uniformly-random 6-digit OTP, zero-padded. `randomBytes` is injected (CSPRNG in prod:
 * `crypto.getRandomValues`) so the mapping is testable. Rejection-samples the biased tail of the u32 range.
 */
export function generateOtp(randomBytes: (n: number) => Uint8Array): string {
  let x: number;
  do {
    const b = randomBytes(4);
    x = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  } while (x >= REJECT_AT);
  return String(x % OTP_CEIL).padStart(OTP_DIGITS, "0");
}

/**
 * Keyed hash of an OTP for storage / verification. HMAC-SHA256 over `userId:code` with a server-held pepper —
 * so a leaked `pending_email_change` row is USELESS without the secret (no offline brute-force of the 1M code
 * space), and a code is bound to the exact user it was issued for. Returns the 32 raw bytes (stored as bytea).
 */
export async function hashOtp(secret: string, userId: string, code: string): Promise<Uint8Array> {
  const key = await importHmacKey(utf8Encoder.encode(secret));
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    utf8Encoder.encode(`${userId}:${code}`) as Uint8Array<ArrayBuffer>,
  );
  return new Uint8Array(mac);
}

/** Constant-time compare of two OTP hashes (length-safe, false on any mismatch). */
export function otpMatches(a: Uint8Array, b: Uint8Array): boolean {
  return timingSafeEqual(a, b);
}
