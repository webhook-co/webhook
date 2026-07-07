import { describe, expect, it } from "vitest";

import { bytesToB64 } from "./bytes";
import { boundedBodyFromBytes, MAX_INLINE_BODY_BYTES } from "./payload-reader-rpc";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("boundedBodyFromBytes", () => {
  it("returns valid UTF-8 verbatim (the JSON-webhook common case)", () => {
    const bytes = utf8('{"id":"evt_1","amount":4200}');
    const r = boundedBodyFromBytes(bytes, bytes.byteLength);
    expect(r.encoding).toBe("utf8");
    expect(r.body).toBe('{"id":"evt_1","amount":4200}');
    expect(r.byteLength).toBe(bytes.byteLength);
    expect(r.truncated).toBe(false);
  });

  it("base64-encodes binary (invalid UTF-8) bytes", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]); // not valid UTF-8
    const r = boundedBodyFromBytes(bytes, bytes.byteLength);
    expect(r.encoding).toBe("base64");
    expect(r.body).toBe(bytesToB64(bytes)); // standard base64 of the raw bytes
    expect(r.truncated).toBe(false);
  });

  it("marks truncated when fewer bytes were returned than stored", () => {
    const bytes = utf8("hello"); // 5 bytes returned
    const r = boundedBodyFromBytes(bytes, 5000); // but 5000 stored
    expect(r.truncated).toBe(true);
    expect(r.encoding).toBe("utf8");
    expect(r.body).toBe("hello");
  });

  it("falls back to base64 when truncation cuts a multibyte char mid-sequence", () => {
    const full = utf8("café"); // é = 2 bytes (0xc3 0xa9)
    const cut = full.slice(0, full.byteLength - 1); // drop the last byte of é → invalid UTF-8 tail
    const r = boundedBodyFromBytes(cut, full.byteLength);
    expect(r.encoding).toBe("base64"); // invalid trailing byte → not decodable as UTF-8
    expect(r.truncated).toBe(true);
  });

  it("exposes a 64 KiB server cap", () => {
    expect(MAX_INLINE_BODY_BYTES).toBe(65_536);
  });
});
