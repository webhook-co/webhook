import { describe, expect, it } from "vitest";

import { generateOtp, hashOtp, otpMatches } from "./email-change-otp";

describe("generateOtp", () => {
  it("always returns a 6-digit numeric string, zero-padded", () => {
    // A rand that yields a small value must still pad to 6 digits (not "42").
    const small = generateOtp(() => new Uint8Array([0, 0, 0, 42]));
    expect(small).toBe("000042");
    expect(small).toMatch(/^\d{6}$/);
  });

  it("maps the raw draw into [0, 1_000_000) — the top of the u32 range wraps by modulo, not overflow", () => {
    // 0xFFFFFFFF = 4294967295 → % 1_000_000 = 967295 (after the reject-sampling accepts it, which it does
    // since 4294967295 < the largest multiple of 1e6 under 2^32 = 4294000000? No — it's ABOVE, so it's
    // rejected and the next draw is used). Provide a second, acceptable draw.
    let call = 0;
    const rand = () => {
      call += 1;
      return call === 1
        ? new Uint8Array([0xff, 0xff, 0xff, 0xff]) // rejected (biased tail)
        : new Uint8Array([0x00, 0x0f, 0x42, 0x40]); // 1_000_000 → %1e6 = 0 → "000000"
    };
    expect(generateOtp(rand)).toBe("000000");
    expect(call).toBe(2); // proved the biased draw was rejected
  });

  it("produces a spread of distinct codes over many draws (not a constant)", () => {
    let seed = 1;
    const rand = () => {
      // a cheap LCG purely to vary the 4 bytes across calls (deterministic, no Math.random)
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return new Uint8Array([
        (seed >> 24) & 0xff,
        (seed >> 16) & 0xff,
        (seed >> 8) & 0xff,
        seed & 0xff,
      ]);
    };
    const seen = new Set(Array.from({ length: 50 }, () => generateOtp(rand)));
    expect(seen.size).toBeGreaterThan(40); // overwhelmingly distinct
    for (const code of seen) expect(code).toMatch(/^\d{6}$/);
  });
});

describe("hashOtp + otpMatches", () => {
  const SECRET = "s".repeat(32);

  it("binds the hash to BOTH the secret pepper and the userId — a leaked row can't be reversed offline", async () => {
    const h = await hashOtp(SECRET, "usr_1", "123456");
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h.length).toBe(32); // HMAC-SHA256

    // Same inputs → same hash (verifiable at commit).
    expect(otpMatches(h, await hashOtp(SECRET, "usr_1", "123456"))).toBe(true);
    // Different code → no match.
    expect(otpMatches(h, await hashOtp(SECRET, "usr_1", "123457"))).toBe(false);
    // Different user (same code) → no match: the code is bound to the user it was issued for.
    expect(otpMatches(h, await hashOtp(SECRET, "usr_2", "123456"))).toBe(false);
    // Different pepper → no match: the row is useless without the server secret.
    expect(otpMatches(h, await hashOtp("t".repeat(32), "usr_1", "123456"))).toBe(false);
  });

  it("otpMatches is length-safe and false on a mismatch", () => {
    expect(otpMatches(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(otpMatches(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(otpMatches(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
  });
});
