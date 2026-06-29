import { describe, expect, it } from "vitest";

import { formatBytes, isBinaryContentType, PAYLOAD_INLINE_MAX } from "./payload-format";

describe("isBinaryContentType", () => {
  it.each([
    "image/png",
    "audio/mpeg",
    "video/mp4",
    "font/woff2",
    "application/octet-stream",
    "application/pdf",
    "application/wasm",
  ])("%s = true", (ct) => expect(isBinaryContentType(ct)).toBe(true));

  it.each(["application/json", "text/plain", "application/xml", "application/vnd.api+json", null])(
    "%s = false",
    (ct) => expect(isBinaryContentType(ct as string | null)).toBe(false),
  );
});

describe("payload format constants + bytes", () => {
  it("PAYLOAD_INLINE_MAX is 256 KiB", () => {
    expect(PAYLOAD_INLINE_MAX).toBe(256 * 1024);
  });

  it.each([
    [500, "500 bytes"],
    [1536, "1.5 KB"],
    [5 * 1024 * 1024, "5.0 MB"],
  ])("formatBytes(%i) = %s", (bytes, expected) => {
    expect(formatBytes(bytes as number)).toBe(expected);
  });
});
