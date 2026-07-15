// Server-side image validation for the avatar upload. NEVER trust a client's declared content-type: sniff the
// real magic bytes and parse the real header dimensions from the raw bytes. Only png / jpeg / webp are
// accepted (the raster formats a browser canvas re-encode produces); SVG is rejected precisely because it can
// carry active content, and GIF is rejected (animation / no need). No decoding happens — dimensions come from
// header fields — so this is safe to run in a Worker on an untrusted body.

export type ImageType = "png" | "jpeg" | "webp";

export interface ImageInfo {
  readonly type: ImageType;
  readonly width: number;
  readonly height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) =>
  (b[i]! * 0x1000000 + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!) >>> 0;

/** The real format from the leading magic bytes, or null if it isn't one of the accepted raster formats. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "png";
  }
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  // WEBP: "RIFF"...."WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "webp";
  }
  // GIF ("GIF8"), SVG (text), and everything else → not accepted.
  return null;
}

function pngDimensions(b: Uint8Array): { width: number; height: number } | null {
  // IHDR is the first chunk: [8-byte sig][4 len]"IHDR"[width u32be @16][height u32be @20].
  if (b.length < 24 || b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) {
    return null;
  }
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  let i = 2; // past the SOI (FF D8)
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null; // markers must be FF-led; a desync means malformed
    const marker = b[i + 1]!;
    // Standalone markers (no length): RSTn (D0-D7), SOI/EOI (D8/D9), TEM (01).
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    // SOF markers carry the frame size: C0–CF except DHT(C4), JPG(C8), DAC(CC).
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) {
      // segment: [len u16][precision u8][height u16][width u16]
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len; // skip this segment
  }
  return null;
}

function webpDimensions(b: Uint8Array): { width: number; height: number } | null {
  // Chunk FourCC at 12..16 selects the sub-format.
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (fourcc === "VP8 ") {
    // Lossy: VP8 bitstream at 20; start code 9D 01 2A at 23; 14-bit width @26 LE, height @28 LE.
    if (b.length < 30 || b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (fourcc === "VP8L") {
    // Lossless: signature 0x2F at 20, then 14-bit width and 14-bit height, LSB-first.
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const b1 = b[21]!;
    const b2 = b[22]!;
    const b3 = b[23]!;
    const b4 = b[24]!;
    const width = 1 + (((b2 & 0x3f) << 8) | b1);
    const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
    return { width, height };
  }
  if (fourcc === "VP8X") {
    // Extended: canvas (width-1) 3 bytes LE @24, (height-1) 3 bytes LE @27.
    if (b.length < 30) return null;
    return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  }
  return null;
}

/** Header dimensions for an already-sniffed type, or null if the header is malformed. No pixel decoding. */
export function imageDimensions(
  b: Uint8Array,
  type: ImageType,
): { width: number; height: number } | null {
  const dims =
    type === "png" ? pngDimensions(b) : type === "jpeg" ? jpegDimensions(b) : webpDimensions(b);
  if (!dims || !Number.isFinite(dims.width) || !Number.isFinite(dims.height)) return null;
  if (dims.width <= 0 || dims.height <= 0) return null;
  return dims;
}

export type AvatarValidation =
  | { readonly ok: true; readonly type: ImageType; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: string };

export interface AvatarValidationOptions {
  readonly maxBytes: number;
  readonly minDim: number;
  readonly maxDim: number;
}

/**
 * Full gate for an uploaded avatar: within the byte cap, a real png/jpeg/webp (magic bytes), and SQUARE with a
 * side in [minDim, maxDim]. The square + bounded check is the defense against a decompression bomb (a
 * tiny-encoded, huge-decoded image that would OOM a viewer's browser) and against non-square images the
 * circular frame would distort.
 */
export function validateAvatarImage(
  b: Uint8Array,
  opts: AvatarValidationOptions,
): AvatarValidation {
  if (b.length === 0) return { ok: false, reason: "empty file" };
  if (b.length > opts.maxBytes) return { ok: false, reason: "file too large" };

  const type = sniffImageType(b);
  if (!type) return { ok: false, reason: "unsupported image type (png, jpeg, or webp only)" };

  const dims = imageDimensions(b, type);
  if (!dims) return { ok: false, reason: "unreadable image header" };
  if (dims.width !== dims.height) return { ok: false, reason: "image must be square" };
  if (dims.width < opts.minDim || dims.width > opts.maxDim) {
    return { ok: false, reason: `image must be ${opts.minDim}–${opts.maxDim}px on a side` };
  }

  return { ok: true, type, width: dims.width, height: dims.height };
}
