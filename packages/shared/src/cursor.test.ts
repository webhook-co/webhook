import { beforeAll, describe, expect, it } from "vitest";

import { bytesToB64url, utf8Encoder } from "./bytes";
import {
  decodeCursor,
  encodeCursor,
  importCursorKey,
  InvalidCursorError,
  msToOrderKey,
  ORDER_KEY_RE,
  orderKeyLagMs,
} from "./cursor";

let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  key = await importCursorKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i)));
  otherKey = await importCursorKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1)));
});

/** Sign an arbitrary payload string with `key` and assemble a `<payload>.<mac>` token — used to forge a
 *  legacy (v1) cursor whose MAC verifies, to prove the decoder still shape-rejects it. */
async function signToken(payloadStr: string, k: CryptoKey): Promise<string> {
  const payload = utf8Encoder.encode(payloadStr);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, payload));
  return `${bytesToB64url(payload)}.${bytesToB64url(sig.slice(0, 16))}`;
}

describe("importCursorKey", () => {
  it("rejects a key that is not 32 bytes (misconfigured/truncated CURSOR_KEY fails loud)", () => {
    expect(() => importCursorKey(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(() => importCursorKey(new Uint8Array(64))).toThrow(/32 bytes/);
  });
});

describe("cursor codec (v2 — full-µs order key)", () => {
  const cursor = {
    orderKey: "2026-06-12T20:00:00.123456Z",
    id: "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060",
  };

  it("round-trips an exact microsecond order key (the ':'-containing ISO survives)", async () => {
    const token = await encodeCursor(cursor, key);
    const back = await decodeCursor(token, key);
    expect(back.orderKey).toBe(cursor.orderKey); // byte-exact, all 6 µs digits preserved
    expect(back.id).toBe(cursor.id);
  });

  it("produces an opaque token (no raw id/timestamp visible)", async () => {
    const token = await encodeCursor(cursor, key);
    expect(token).not.toContain(cursor.id);
    expect(token).not.toContain(cursor.orderKey);
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

  it("FAILS CLOSED on a legacy v1 (<ms>:<id>) cursor even though its MAC verifies", async () => {
    // A v1 cursor was signed with the same CURSOR_KEY, so the MAC is valid — the decoder must reject it on
    // SHAPE (not version 2), because a ms→µs upgrade can't be gapless. Client restarts pagination.
    const v1 = await signToken(`1749758400123:${cursor.id}`, key);
    await expect(decodeCursor(v1, key)).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("rejects a v2 payload with a malformed order key or id (shape validation)", async () => {
    const bad = [
      `2|2026-06-12T20:00:00.123Z|${cursor.id}`, // only 3 µs digits (not 6)
      `2|2026-06-12T20:00:00.123456|${cursor.id}`, // missing trailing Z
      `2|2026-06-12 20:00:00.123456Z|${cursor.id}`, // space instead of T
      `2|${cursor.orderKey}|not-a-uuid`, // bad id
      `3|${cursor.orderKey}|${cursor.id}`, // unknown version
      `2|${cursor.orderKey}`, // missing id segment
    ];
    for (const p of bad) {
      const token = await signToken(p, key);
      await expect(decodeCursor(token, key)).rejects.toBeInstanceOf(InvalidCursorError);
    }
  });
});

describe("msToOrderKey (upgrade a pre-µs ms position → a v2 order key)", () => {
  it("produces a valid 6-digit UTC ISO-µs order key with .sss000Z (ms zero-padded to µs)", () => {
    const ms = Date.UTC(2026, 5, 12, 20, 0, 0, 123); // 2026-06-12T20:00:00.123Z
    const key = msToOrderKey(ms);
    expect(key).toBe("2026-06-12T20:00:00.123000Z");
    expect(ORDER_KEY_RE.test(key)).toBe(true); // decodeCursor/ORDER_KEY_RE accept it
  });

  it("round-trips back to the SAME millisecond (upgrade is position-preserving, no gap)", () => {
    const ms = Date.UTC(2026, 0, 1, 0, 0, 0, 7);
    expect(new Date(msToOrderKey(ms)).getTime()).toBe(ms); // .007000Z parses back to exactly ms
  });
});

describe("orderKeyLagMs (advisory head-lag, shared by api status + tunnel status)", () => {
  it("is the ms delta from the order key to now, floored at 0", () => {
    const now = Date.UTC(2026, 5, 12, 20, 0, 5, 0);
    expect(orderKeyLagMs("2026-06-12T20:00:00.000000Z", now)).toBe(5000);
  });

  it("never returns a negative lag (a head in the future clamps to 0)", () => {
    const now = Date.UTC(2026, 5, 12, 20, 0, 0, 0);
    expect(orderKeyLagMs("2026-06-12T20:00:10.000000Z", now)).toBe(0);
  });

  it("coarsens the µs order key to ms (advisory, not µs-exact)", () => {
    const now = Date.UTC(2026, 5, 12, 20, 0, 1, 0);
    // .000900Z (900µs) coarsens to the same ms as .000000Z → both report 1000ms of lag.
    expect(orderKeyLagMs("2026-06-12T20:00:00.000900Z", now)).toBe(1000);
  });
});
