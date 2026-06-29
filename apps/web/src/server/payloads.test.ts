import { describe, expect, it, vi } from "vitest";

import {
  downloadExtension,
  loadEventPayload,
  openPayloadForDownload,
  type PayloadReaders,
} from "./payloads";

const ENDPOINT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const EVENT_ID = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

/** A clean ArrayBuffer for the given bytes (avoids TextEncoder over-allocation surprises). */
function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function r2Object(bytes: Uint8Array) {
  return { arrayBuffer: async () => ab(bytes), body: new ReadableStream(), size: bytes.byteLength };
}

function readers(over: Partial<PayloadReaders> = {}): PayloadReaders {
  return {
    getEventForPayload: vi.fn(async () => ({
      payloadR2Key: "dev/payloads/evt.json",
      payloadBytes: 7,
      contentType: "application/json",
    })),
    getObject: vi.fn(async () => r2Object(textBytes('{"a":1}'))),
    ...over,
  };
}

describe("loadEventPayload", () => {
  it("returns decoded text for a small text body", async () => {
    const result = await loadEventPayload("o", ENDPOINT_ID, EVENT_ID, readers());
    expect(result).toEqual({
      kind: "text",
      text: '{"a":1}',
      bytes: 7,
      contentType: "application/json",
    });
  });

  it("returns too_large WITHOUT reading R2 for an oversized body", async () => {
    const r = readers({
      getEventForPayload: vi.fn(async () => ({
        payloadR2Key: "k",
        payloadBytes: 5_000_000,
        contentType: "application/json",
      })),
    });
    expect(await loadEventPayload("o", ENDPOINT_ID, EVENT_ID, r)).toMatchObject({
      kind: "too_large",
    });
    expect(r.getObject).not.toHaveBeenCalled();
  });

  it("returns binary WITHOUT reading R2 for a known-binary content type", async () => {
    const r = readers({
      getEventForPayload: vi.fn(async () => ({
        payloadR2Key: "k",
        payloadBytes: 100,
        contentType: "image/png",
      })),
    });
    expect(await loadEventPayload("o", ENDPOINT_ID, EVENT_ID, r)).toMatchObject({ kind: "binary" });
    expect(r.getObject).not.toHaveBeenCalled();
  });

  it("falls back to binary when an unknown body is NOT valid UTF-8 (strict decode)", async () => {
    const r = readers({
      getEventForPayload: vi.fn(async () => ({
        payloadR2Key: "k",
        payloadBytes: 2,
        contentType: null,
      })),
      // 0xFF 0x28 is an invalid UTF-8 sequence → strict decode rejects → binary (not U+FFFD mojibake).
      getObject: vi.fn(async () => r2Object(new Uint8Array([0xff, 0x28]))),
    });
    expect(await loadEventPayload("o", ENDPOINT_ID, EVENT_ID, r)).toMatchObject({ kind: "binary" });
  });

  it("returns pruned when the R2 object is missing", async () => {
    const r = readers({ getObject: vi.fn(async () => null) });
    expect(await loadEventPayload("o", ENDPOINT_ID, EVENT_ID, r)).toEqual({ kind: "pruned" });
  });

  it("returns not_found for an unknown / cross-endpoint event", async () => {
    const r = readers({ getEventForPayload: vi.fn(async () => null) });
    expect(await loadEventPayload("o", ENDPOINT_ID, EVENT_ID, r)).toEqual({ kind: "not_found" });
  });

  it("returns not_found for a non-uuid id WITHOUT touching the db", async () => {
    const r = readers();
    expect(await loadEventPayload("o", "nope", EVENT_ID, r)).toEqual({ kind: "not_found" });
    expect(r.getEventForPayload).not.toHaveBeenCalled();
  });

  it("returns error (no throw) on a fault", async () => {
    const r = readers({
      getEventForPayload: vi.fn(async () => {
        throw new Error("hyperdrive down");
      }),
    });
    expect(await loadEventPayload("o", ENDPOINT_ID, EVENT_ID, r)).toEqual({ kind: "error" });
  });
});

describe("openPayloadForDownload", () => {
  it("returns the stream + size + content type", async () => {
    const result = await openPayloadForDownload("o", ENDPOINT_ID, EVENT_ID, readers());
    expect(result).toMatchObject({ size: 7, contentType: "application/json" });
    expect(result).not.toBe("not_found");
  });

  it("returns not_found for a missing event or pruned object", async () => {
    expect(
      await openPayloadForDownload(
        "o",
        ENDPOINT_ID,
        EVENT_ID,
        readers({ getEventForPayload: vi.fn(async () => null) }),
      ),
    ).toBe("not_found");
    expect(
      await openPayloadForDownload(
        "o",
        ENDPOINT_ID,
        EVENT_ID,
        readers({ getObject: vi.fn(async () => null) }),
      ),
    ).toBe("not_found");
  });

  it("returns not_found for a non-uuid id", async () => {
    expect(await openPayloadForDownload("o", "nope", EVENT_ID, readers())).toBe("not_found");
  });

  it("returns error (no throw) on a fault", async () => {
    const r = readers({
      getObject: vi.fn(async () => {
        throw new Error("r2 down");
      }),
    });
    expect(await openPayloadForDownload("o", ENDPOINT_ID, EVENT_ID, r)).toBe("error");
  });
});

describe("downloadExtension", () => {
  it.each([
    ["application/json", "json"],
    ["application/vnd.api+json", "json"],
    ["application/xml", "xml"],
    ["text/plain", "txt"],
    ["application/x-www-form-urlencoded", "txt"],
    ["image/png", "bin"],
    [null, "bin"],
  ])("downloadExtension(%s) = %s", (ct, ext) =>
    expect(downloadExtension(ct as string | null)).toBe(ext),
  );
});
