// Self-describing checksum for `whk_` API keys (ADR-0073). The minted key is
//   whk_ + <43 base62 chars: a 256-bit CSPRNG body> + <6 base62 chars: CRC32 of the body>
// so a malformed / truncated / typo'd key is rejected cheaply — at the edge before any DB
// lookup, and client-side by tooling — and the format is registrable with secret-scanning.
//
// THE CHECKSUM IS NOT A SECURITY CONTROL. CRC32 is a public, trivially-forgeable error-detection
// code; key security rests entirely on the 256-bit secret + the peppered HMAC-at-rest
// (see credential.ts). The checksum only catches accidental corruption and lets scanners
// recognise the prefix. Do not treat verifyKeyChecksum as authentication.
//
// Pure + deterministic on purpose (no randomness, no I/O) — the random draw lives in
// credential.ts (mintChecksummedCredential). That keeps this module exhaustively unit-testable
// and lets the resolver call verifyKeyChecksum as a cheap precheck.

/** base62 alphabet, ASCII, MSB-first: '0'..'9','A'..'Z','a'..'z' (values 0..61). */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Chars of CSPRNG body: ceil(256 / log2(62)) = 43 (62^42 < 2^256 < 62^43 — the tight minimum). */
export const RANDOM_BODY_LEN = 43;

/** Chars to fixed-width-encode a 32-bit CRC: 62^5 < 2^32 < 62^6, so 6 (max value -> "4gfFC3"). */
export const CHECKSUM_LEN = 6;

/** The whk_-body charset, for fast structural rejection (no base64url '-' / '_'). */
const BODY_RE = /^[0-9A-Za-z]+$/;

// CRC32 table (IEEE 802.3 reflected polynomial 0xEDB88320), built once.
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32 (IEEE 802.3) over the UTF-8/ASCII bytes of `input`, returned as an unsigned 32-bit
 * integer. The whk_ body is pure base62 (ASCII), so `charCodeAt(i)` is the byte — and the
 * checksum is computed over the body STRING (the only thing verifyKeyChecksum has in hand).
 */
export function crc32(input: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc = CRC32_TABLE[(crc ^ input.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Render a non-negative bigint to a base62 string left-padded to exactly `width` chars. This is
 * a fixed-width bijection over [0, 62^width): the body uses width 43 (so a uniform 256-bit draw
 * maps to a uniform, constant-length 43-char string with NO modulo bias and NO leading-zero
 * truncation), the checksum uses width 6. THROWS if the value can't fit `width` chars rather
 * than silently truncating (a truncated body would break the fixed-width secret-scanning regex).
 */
export function toBase62Fixed(n: bigint, width: number): string {
  if (n < 0n) throw new Error("toBase62Fixed: value must be non-negative");
  let out = "";
  let x = n;
  const base = 62n;
  while (x > 0n) {
    out = BASE62[Number(x % base)]! + out;
    x /= base;
  }
  if (out.length > width) {
    throw new Error(`toBase62Fixed: value does not fit in width ${width}`);
  }
  return out.padStart(width, "0");
}

/** The 6-char base62 CRC32 checksum of a key body string. */
export function keyChecksum(body: string): string {
  return toBase62Fixed(BigInt(crc32(body) >>> 0), CHECKSUM_LEN);
}

/**
 * Validate a presented plaintext against the `<prefix>_<43 base62><6 base62 crc>` shape and its
 * self-describing checksum. Returns false for ANY structural problem — wrong prefix, wrong
 * length, non-base62 chars (e.g. an old base64url key with '-'/'_'), or a checksum mismatch —
 * before any hashing / cache / DB work. Not constant-time and not a security boundary: the
 * checksum is public error-detection, so a plain compare is correct.
 */
export function verifyKeyChecksum(prefix: string, plaintext: string): boolean {
  const sep = `${prefix}_`;
  if (!plaintext.startsWith(sep)) return false;
  const body = plaintext.slice(sep.length);
  if (body.length !== RANDOM_BODY_LEN + CHECKSUM_LEN) return false;
  if (!BODY_RE.test(body)) return false;
  const random = body.slice(0, RANDOM_BODY_LEN);
  const provided = body.slice(RANDOM_BODY_LEN);
  return keyChecksum(random) === provided;
}
