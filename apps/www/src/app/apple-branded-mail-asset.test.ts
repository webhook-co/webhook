import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guard on the SHIPPED Apple Branded Mail logo.
 *
 * Apple Business Connect requires a SQUARE bitmap, 1024x1024 to 4864x4864. Apple applies its own
 * circular/rounded crop, so the artwork must be full-bleed and fully opaque — an alpha channel leaves
 * ragged corners once cropped. `public/logo.png` fails BOTH rules (512x512, RGBA with transparent
 * rounded corners), which is exactly why this separate asset exists.
 *
 * Regenerate with: pnpm --filter @webhook-co/www gen:brand-mail
 */

const PNG_PATH = join(process.cwd(), "public", "bimi", "apple-branded-mail.png");
const png = readFileSync(PNG_PATH);

/** Parse an IHDR chunk. PNG layout: 8-byte signature, then length(4) + "IHDR"(4) + width(4) + height(4) + bitDepth(1) + colorType(1). */
function ihdr(buf: Buffer) {
  expect(buf.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

describe("Apple Branded Mail logo", () => {
  const { width, height, colorType } = ihdr(png);

  it("is square", () => {
    expect(width).toBe(height);
  });

  it("is within Apple's 1024-4864 px range", () => {
    expect(width).toBeGreaterThanOrEqual(1024);
    expect(width).toBeLessThanOrEqual(4864);
  });

  // colorType 4 (grey+alpha) and 6 (RGBA) carry an alpha channel; 0/2/3 do not.
  it("has NO alpha channel (Apple crops it — transparency would ragged the edge)", () => {
    expect([4, 6]).not.toContain(colorType);
  });
});
