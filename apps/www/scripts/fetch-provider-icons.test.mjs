import assert from "node:assert/strict";
import { test } from "node:test";

import { rejectIcon } from "./fetch-provider-icons.mjs";

// The icon bytes come off the network and are then written to disk and handed to `cwebp`. What we
// are willing to write is decided by sniffing the CONTENT — not the declared type, not the URL.
// Importing this module must not fetch anything; if the main-module guard regresses, this test hangs
// on 64 network calls, which is its own loud signal.

const png = (bytes = 200) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(bytes - 8, 0x01),
  ]);

test("a well-formed PNG of a plausible size is accepted", () => {
  assert.equal(rejectIcon(png(), 200), null);
});

test("a non-200 is refused, however good the body looks", () => {
  assert.equal(rejectIcon(png(), 404), "HTTP 404");
  assert.equal(rejectIcon(png(), 302), "HTTP 302");
});

test("an empty body — what Google returns for a domain it does not know — is refused", () => {
  assert.match(rejectIcon(Buffer.alloc(0), 200), /too small/);
  assert.match(rejectIcon(png(64), 200), /too small/);
});

test("a body that is not a PNG is refused rather than written to disk", () => {
  // HTML (an error page or a redirect interstitial) is the realistic case: it is big enough to clear
  // the size floor, so ONLY the magic-byte check stands between it and `public/providers/*.png`.
  const html = Buffer.from(`<!doctype html><html><body>${"x".repeat(300)}</body></html>`);
  assert.ok(html.length > 100, "fixture must clear the size floor to be a real test");
  assert.equal(rejectIcon(html, 200), "not a PNG");

  // An SVG that merely *contains* the PNG magic later in the body must not pass either — the
  // signature has to be at offset 0.
  const sneaky = Buffer.concat([Buffer.from("<svg>".padEnd(120, " ")), png()]);
  assert.equal(rejectIcon(sneaky, 200), "not a PNG");
});

test("an implausibly large body is refused (a favicon is a few KB, not a few MB)", () => {
  assert.match(rejectIcon(png(600 * 1024), 200), /too large/);
});
