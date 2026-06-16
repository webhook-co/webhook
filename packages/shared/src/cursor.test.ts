import { beforeAll, describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor, importCursorKey, InvalidCursorError } from "./cursor";

let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  key = await importCursorKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i)));
  otherKey = await importCursorKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)));
});

describe("importCursorKey", () => {
  it("rejects a key that is not 32 bytes (misconfigured/truncated CURSOR_KEY fails loud)", () => {
    expect(() => importCursorKey(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(() => importCursorKey(new Uint8Array(64))).toThrow(/32 bytes/);
  });
});

describe("cursor codec", () => {
  const cursor = {
    receivedAt: new Date("2026-06-12T20:00:00.123Z"),
    id: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060",
  };

  it("round-trips a cursor", async () => {
    const token = await encodeCursor(cursor, key);
    const back = await decodeCursor(token, key);
    expect(back.id).toBe(cursor.id);
    expect(back.receivedAt.getTime()).toBe(cursor.receivedAt.getTime());
  });

  it("produces an opaque token (no raw id/timestamp visible)", async () => {
    const token = await encodeCursor(cursor, key);
    expect(token).not.toContain(cursor.id);
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("rejects a cursor signed with a different key (tamper-evidence)", async () => {
    const token = await encodeCursor(cursor, key);
    await expect(decodeCursor(token, otherKey)).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("rejects a tampered payload", async () => {
    const token = await encodeCursor(cursor, key);
    const [payload, mac] = token.split(".");
    const flipped = (payload![0] === "A" ? "B" : "A") + payload!.slice(1);
    await expect(decodeCursor(`${flipped}.${mac}`, key)).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("rejects a structurally invalid token", async () => {
    await expect(decodeCursor("nodot", key)).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(decodeCursor(".x", key)).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(decodeCursor("x.", key)).rejects.toBeInstanceOf(InvalidCursorError);
  });
});
