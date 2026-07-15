import { describe, expect, it } from "vitest";

import {
  imageDimensions,
  sniffImageType,
  validateAvatarImage,
  type ImageType,
} from "./image-validate";

// ── Minimal header fixtures with KNOWN dimensions (no encoder needed) ──────────────────────────────────────

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); // IHDR chunk header
  b[16] = (w >>> 24) & 0xff;
  b[17] = (w >>> 16) & 0xff;
  b[18] = (w >>> 8) & 0xff;
  b[19] = w & 0xff;
  b[20] = (h >>> 24) & 0xff;
  b[21] = (h >>> 16) & 0xff;
  b[22] = (h >>> 8) & 0xff;
  b[23] = h & 0xff;
  return b;
}

/** JPEG with an APP0 segment first (to exercise the skip loop), then an SOF0 with the real size. */
function jpeg(w: number, h: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]; // marker + len=4 + 2 payload bytes
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0, 0, 0]);
}

function webpVP8(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  b.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  b.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  b.set([0x9d, 0x01, 0x2a], 23); // start code
  b[26] = w & 0xff;
  b[27] = (w >> 8) & 0x3f;
  b[28] = h & 0xff;
  b[29] = (h >> 8) & 0x3f;
  return b;
}

function webpVP8L(w: number, h: number): Uint8Array {
  const b = new Uint8Array(25);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
  b[20] = 0x2f; // signature
  const wm1 = w - 1;
  const hm1 = h - 1;
  b[21] = wm1 & 0xff;
  b[22] = ((wm1 >> 8) & 0x3f) | ((hm1 & 0x03) << 6);
  b[23] = (hm1 >> 2) & 0xff;
  b[24] = (hm1 >> 10) & 0x0f;
  return b;
}

function webpVP8X(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const wm1 = w - 1;
  const hm1 = h - 1;
  b[24] = wm1 & 0xff;
  b[25] = (wm1 >> 8) & 0xff;
  b[26] = (wm1 >> 16) & 0xff;
  b[27] = hm1 & 0xff;
  b[28] = (hm1 >> 8) & 0xff;
  b[29] = (hm1 >> 16) & 0xff;
  return b;
}

describe("sniffImageType", () => {
  it("recognizes png / jpeg / webp by magic bytes", () => {
    expect(sniffImageType(png(1, 1))).toBe("png");
    expect(sniffImageType(jpeg(1, 1))).toBe("jpeg");
    expect(sniffImageType(webpVP8(1, 1))).toBe("webp");
  });

  it("rejects SVG, GIF, and anything else", () => {
    expect(sniffImageType(new TextEncoder().encode('<svg xmlns="..."></svg>'))).toBeNull();
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull(); // GIF89a
    expect(sniffImageType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("imageDimensions", () => {
  const cases: [string, ImageType, (w: number, h: number) => Uint8Array][] = [
    ["png", "png", png],
    ["jpeg (with a skipped APP0)", "jpeg", jpeg],
    ["webp VP8 (lossy)", "webp", webpVP8],
    ["webp VP8L (lossless)", "webp", webpVP8L],
    ["webp VP8X (extended)", "webp", webpVP8X],
  ];
  for (const [name, type, make] of cases) {
    it(`parses ${name} dimensions`, () => {
      expect(imageDimensions(make(512, 512), type)).toEqual({ width: 512, height: 512 });
      expect(imageDimensions(make(1024, 768), type)).toEqual({ width: 1024, height: 768 });
      expect(imageDimensions(make(16, 16), type)).toEqual({ width: 16, height: 16 });
    });
  }

  it("returns null for a truncated/garbage header", () => {
    expect(imageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "png")).toBeNull();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]), "jpeg")).toBeNull();
  });
});

describe("validateAvatarImage", () => {
  const opts = { maxBytes: 1_000_000, minDim: 16, maxDim: 1024 };

  it("accepts a square webp within bounds", () => {
    expect(validateAvatarImage(webpVP8(512, 512), opts)).toEqual({
      ok: true,
      type: "webp",
      width: 512,
      height: 512,
    });
  });

  it("rejects a non-square image (would distort in the circular frame)", () => {
    expect(validateAvatarImage(png(512, 256), opts)).toMatchObject({ ok: false });
  });

  it("rejects an over-max dimension (decompression-bomb guard) and an under-min one", () => {
    expect(validateAvatarImage(webpVP8X(4096, 4096), opts)).toMatchObject({ ok: false });
    expect(validateAvatarImage(png(8, 8), opts)).toMatchObject({ ok: false });
  });

  it("rejects an over-size body, an empty body, and a non-image", () => {
    expect(validateAvatarImage(png(64, 64), { ...opts, maxBytes: 10 })).toMatchObject({
      ok: false,
    });
    expect(validateAvatarImage(new Uint8Array(), opts)).toMatchObject({ ok: false });
    expect(validateAvatarImage(new TextEncoder().encode("<svg/>"), opts)).toMatchObject({
      ok: false,
    });
  });
});
