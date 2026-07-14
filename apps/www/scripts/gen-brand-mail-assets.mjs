#!/usr/bin/env node
/**
 * Rasterises the BIMI indicator into the bitmap Apple Business Connect wants.
 *
 * The SVG is the single source of truth: BIMI needs SVG Tiny P/S, Apple needs a square opaque bitmap
 * 1024-4864px, and keeping one vector master means the two channels can never drift to different marks.
 *
 * `flatten()` is what strips the alpha channel — Apple crops the logo to a circle, and any transparency
 * survives that crop as a ragged edge. `public/logo.png` (512x512 RGBA, rounded corners) is unusable for
 * this and must not be substituted.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "public", "bimi", "logo.svg");
const OUT = join(here, "..", "public", "bimi", "apple-branded-mail.png");

const BACKGROUND = "#0e141b"; // must match the <rect> fill in logo.svg
const SIZE = 2048; // comfortably inside Apple's 1024-4864 range

mkdirSync(dirname(OUT), { recursive: true });

await sharp(readFileSync(SRC), { density: 384 })
  .resize(SIZE, SIZE, { fit: "fill" })
  .flatten({ background: BACKGROUND })
  .png({ compressionLevel: 9 })
  .toFile(OUT);

const { width, height, channels, hasAlpha } = await sharp(OUT).metadata();
if (width !== height || width < 1024 || width > 4864 || hasAlpha) {
  throw new Error(
    `generated asset violates Apple's spec: ${width}x${height} channels=${channels} alpha=${hasAlpha}`,
  );
}
console.log(`wrote ${OUT} — ${width}x${height}, ${channels} channels, alpha=${hasAlpha}`);
