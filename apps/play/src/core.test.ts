import { describe, expect, it } from "vitest";

import {
  ABSOLUTE_TTL_MS,
  BODY_CAP_BYTES,
  buildCaptureRecord,
  capBody,
  isExpired,
  newIngestToken,
  newViewerSecret,
  sseFrame,
  timingSafeEqual,
  TOKEN_BYTES,
} from "./core";

describe("tokens", () => {
  it("are 128-bit (32 hex chars) and unique across many draws", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = newIngestToken();
      expect(t).toMatch(/^[0-9a-f]{32}$/);
      expect(t.length).toBe(TOKEN_BYTES * 2);
      tokens.add(t);
    }
    expect(tokens.size).toBe(1000); // no collisions → unguessable/non-enumerable
  });

  it("mints a viewer secret distinct from the ingest token", () => {
    expect(newViewerSecret()).not.toBe(newIngestToken());
    expect(newViewerSecret()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("timingSafeEqual", () => {
  it("is true only for identical strings", () => {
    const s = newViewerSecret();
    expect(timingSafeEqual(s, s)).toBe(true);
    expect(timingSafeEqual(s, newViewerSecret())).toBe(false);
  });

  it("is false for different lengths (and never throws)", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });
});

describe("absolute TTL", () => {
  it("expires exactly at mintedAt + ttl and stays expired (activity cannot extend it)", () => {
    const minted = 1_000_000;
    expect(isExpired(minted, minted)).toBe(false);
    expect(isExpired(minted, minted + ABSOLUTE_TTL_MS - 1)).toBe(false);
    expect(isExpired(minted, minted + ABSOLUTE_TTL_MS)).toBe(true);
    expect(isExpired(minted, minted + ABSOLUTE_TTL_MS + 10_000_000)).toBe(true);
  });
});

describe("capBody", () => {
  it("passes a small body through untruncated", () => {
    const bytes = new TextEncoder().encode("hello");
    const r = capBody(bytes);
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
    expect(r.bodyBytes).toBe(5);
  });

  it("truncates at the cap and reports the true original size", () => {
    const big = new Uint8Array(BODY_CAP_BYTES + 500).fill(65); // 'A'
    const r = capBody(big);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(BODY_CAP_BYTES);
    expect(r.bodyBytes).toBe(BODY_CAP_BYTES + 500);
  });

  it("renders arbitrary binary as inert replacement chars, never throwing", () => {
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80]);
    expect(() => capBody(binary)).not.toThrow();
    const r = capBody(binary);
    expect(typeof r.text).toBe("string");
  });
});

describe("buildCaptureRecord", () => {
  it("captures method, headers, content-type, and the capped body", () => {
    const rec = buildCaptureRecord({
      id: "c1",
      method: "POST",
      headers: [
        ["content-type", "application/json"],
        ["x-custom", "v"],
      ],
      bodyBytes: new TextEncoder().encode('{"a":1}'),
      receivedAt: 42,
    });
    expect(rec.method).toBe("POST");
    expect(rec.contentType).toBe("application/json");
    expect(rec.headers).toEqual([
      ["content-type", "application/json"],
      ["x-custom", "v"],
    ]);
    expect(rec.body).toBe('{"a":1}');
    expect(rec.receivedAt).toBe(42);
  });
});

describe("sseFrame — XSS/stream-spoof safety", () => {
  it("keeps an attacker payload on a SINGLE data line (no injected second frame)", () => {
    // A body that TRIES to break SSE framing and inject a fake event.
    const rec = buildCaptureRecord({
      id: "c1",
      method: "POST",
      headers: [],
      bodyBytes: new TextEncoder().encode('\n\ndata: {"spoofed":true}\n\n'),
      receivedAt: 1,
    });
    const frame = sseFrame(rec);
    // Exactly one frame terminator (the trailing \n\n) — the newlines in the body are JSON-escaped.
    expect(frame.match(/\n\n/g)?.length).toBe(1);
    expect(frame.startsWith("data: ")).toBe(true);
    // The literal "spoofed" bytes survive only as escaped JSON inside the one data line.
    expect(frame).toContain("\\n\\ndata:");
    // And it round-trips: the client parses the JSON, never the raw framing.
    const parsed = JSON.parse(frame.slice("data: ".length).trim());
    expect(parsed.body).toBe('\n\ndata: {"spoofed":true}\n\n');
  });

  it("does not let an HTML/script body escape JSON encoding", () => {
    const rec = buildCaptureRecord({
      id: "c1",
      method: "POST",
      headers: [],
      bodyBytes: new TextEncoder().encode("<img src=x onerror=alert(1)>"),
      receivedAt: 1,
    });
    const parsed = JSON.parse(sseFrame(rec).slice("data: ".length).trim());
    // The client renders parsed.body as an inert React text node — never HTML. Here we assert the
    // dangerous bytes survive only as data, not as a second SSE frame or broken JSON.
    expect(parsed.body).toBe("<img src=x onerror=alert(1)>");
  });
});
