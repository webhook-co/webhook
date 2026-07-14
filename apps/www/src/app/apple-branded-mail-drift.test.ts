// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

/**
 * Drift guard: `public/bimi/apple-branded-mail.png` is DERIVED from `public/bimi/logo.svg`.
 *
 * Without this, the derivation is enforced by a comment. Someone recolours the mark in logo.svg, forgets
 * `pnpm gen:brand-mail`, and every check stays green — bimi-asset.test.ts only reads the SVG,
 * apple-branded-mail-asset.test.ts only reads the PNG's IHDR, and neither compares them. The BIMI
 * channel would then show the NEW mark while Apple Mail shows the OLD one indefinitely, discoverable
 * only by a human eyeballing an Apple Mail message.
 *
 * This is the repo's "a derived artifact's guard needs its SOURCE in the trigger" rule: the guard reads
 * the SOURCE (logo.svg), re-derives, and compares to the committed OUTPUT.
 *
 * Compares decoded PIXELS, not file bytes — a sharp/libvips version bump changes PNG compression output
 * without changing a single pixel, and a byte-compare would go red on an upgrade for no real reason.
 */

const dir = join(process.cwd(), "public", "bimi");
const SVG = join(dir, "logo.svg");
const PNG = join(dir, "apple-branded-mail.png");

// Must mirror scripts/gen-brand-mail-assets.mjs exactly.
const SIZE = 2048;
const BACKGROUND = "#0e141b";

describe("apple-branded-mail.png is in sync with logo.svg", () => {
  it("matches a fresh rasterisation of the SVG, pixel for pixel", async () => {
    const expected = await sharp(readFileSync(SVG), { density: 384 })
      .resize(SIZE, SIZE, { fit: "fill" })
      .flatten({ background: BACKGROUND })
      .raw()
      .toBuffer();

    const committed = await sharp(readFileSync(PNG))
      .flatten({ background: BACKGROUND })
      .raw()
      .toBuffer();

    expect(
      committed.length,
      "committed PNG has different dimensions than a fresh render of logo.svg — run `pnpm --filter @webhook-co/www gen:brand-mail`",
    ).toBe(expected.length);

    expect(
      committed.equals(expected),
      "committed PNG no longer matches logo.svg — run `pnpm --filter @webhook-co/www gen:brand-mail` and commit the result",
    ).toBe(true);
  });
});
