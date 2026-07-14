import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guard on the SHIPPED BIMI indicator. Reads `public/bimi/logo.svg` itself — not a fixture — because a
 * test that validates a copy proves nothing about what we serve.
 *
 * BIMI requires SVG Tiny Portable/Secure (draft-svg-tiny-ps-abrotman), a restriction of SVG Tiny 1.2.
 * Receivers fetch this file at delivery time; a malformed one produces a BIMI *failure*, which is worse
 * than publishing no record at all.
 */

const SVG_PATH = join(process.cwd(), "public", "bimi", "logo.svg");
const svg = readFileSync(SVG_PATH, "utf8");

describe("BIMI indicator (SVG Tiny P/S)", () => {
  it("declares version 1.2 and baseProfile tiny-ps", () => {
    expect(svg).toMatch(/version="1\.2"/);
    expect(svg).toMatch(/baseProfile="tiny-ps"/);
  });

  it("carries a <title> (required: names the brand)", () => {
    expect(svg).toMatch(/<title>[^<]+<\/title>/);
  });

  it("has no x/y attributes on the root <svg> (forbidden by the profile)", () => {
    const root = svg.slice(svg.indexOf("<svg"), svg.indexOf(">", svg.indexOf("<svg")) + 1);
    expect(root).not.toMatch(/\sx=/);
    expect(root).not.toMatch(/\sy=/);
  });

  it("is square", () => {
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
    expect(viewBox).toBeDefined();
    const [, , w, h] = viewBox!.trim().split(/\s+/).map(Number);
    expect(w).toBe(h);
  });

  // Receivers render the indicator circle-cropped. A transparent background bleeds through as a
  // ragged edge, so the profile calls for a solid one: the artwork must paint the FULL viewBox.
  it("paints a solid full-bleed background (no transparent corners)", () => {
    const viewBox = svg.match(/viewBox="([^"]+)"/)![1];
    const [, , w, h] = viewBox.trim().split(/\s+/).map(Number);
    const bg = svg.match(/<rect[^>]*\/?>/)?.[0];
    expect(bg, "expected a background <rect>").toBeDefined();
    expect(bg).toMatch(new RegExp(`width="${w}"`));
    expect(bg).toMatch(new RegExp(`height="${h}"`));
    expect(bg).toMatch(/fill="#[0-9a-fA-F]{3,6}"/);
    // A corner radius would leave the corners unpainted.
    expect(bg).not.toMatch(/\srx=/);
    expect(bg).not.toMatch(/\sry=/);
  });

  it("contains no scripts, animation, interactivity or external references", () => {
    for (const forbidden of [
      /<script/i,
      /<a[\s>]/i,
      /<image/i,
      /<foreignObject/i,
      /<animate/i,
      /<set[\s>]/i,
      /\son\w+=/i, // event handlers
      /xlink:href/i,
      /href=/i,
      /url\(/i, // external paint refs
      /@import/i,
    ]) {
      expect(svg, `must not contain ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it("stays under the 16 KB ceiling receivers enforce", () => {
    expect(Buffer.byteLength(svg, "utf8")).toBeLessThan(16 * 1024);
  });
});
