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

test("a body that is neither PNG nor JPEG is refused rather than written to disk", () => {
  // HTML (an error page or a redirect interstitial) is the realistic case: it is big enough to clear
  // the size floor, so ONLY the magic-byte check stands between it and `public/providers/*.png`.
  const html = Buffer.from(`<!doctype html><html><body>${"x".repeat(300)}</body></html>`);
  assert.ok(html.length > 100, "fixture must clear the size floor to be a real test");
  assert.equal(rejectIcon(html, 200), "not a PNG or JPEG");

  // An SVG that merely *contains* the PNG magic later in the body must not pass either — the
  // signature has to be at offset 0.
  const sneaky = Buffer.concat([Buffer.from("<svg>".padEnd(120, " ")), png()]);
  assert.equal(rejectIcon(sneaky, 200), "not a PNG or JPEG");
});

test("an implausibly large body is refused (a favicon is a few KB, not a few MB)", () => {
  assert.match(rejectIcon(png(600 * 1024), 200), /too large/);
});

// Issue #788 — Google's favicon service does not always answer in PNG. For `doppler.com` it returns
// a perfectly good JPEG, which the PNG-only magic check refused as "not a PNG", leaving the provider
// with no committed icon and `provider-wall.test.tsx` failing for a file that was never broken.
//
// The guard's job is to refuse an EMPTY or NON-IMAGE body — an HTML error page written to disk and
// handed to `cwebp` is the failure it exists to prevent. JPEG is neither of those, and `cwebp` decodes
// it natively, so accepting it costs nothing and is not a loosening of the real invariant.
test("a JPEG is accepted — cwebp decodes it, and Google answers in JPEG for some domains", () => {
  // SOI + APP0/JFIF, the real 4-byte JPEG start, then padding to clear the size floor.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 0x20)]);
  assert.equal(rejectIcon(jpeg, 200), null);
});

test("HTML is STILL refused after JPEG was allowed — the widening did not open the door", () => {
  // The check that matters: adding a second accepted format must not turn the sniff into a
  // rubber stamp. This is the case the original guard was written for.
  const html = Buffer.from(`<!doctype html><html><body>${"x".repeat(400)}</body></html>`);
  assert.equal(rejectIcon(html, 200), "not a PNG or JPEG");

  // A body whose JPEG magic appears LATER rather than at offset 0 must not pass either.
  const sneaky = Buffer.concat([
    Buffer.alloc(16, 0x20),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(400, 0x20),
  ]);
  assert.equal(rejectIcon(sneaky, 200), "not a PNG or JPEG");
});
