import { describe, expect, it } from "vitest";

import { hexToBytes, utf8Encoder } from "../bytes";
import { verifyEd25519 } from "./asymmetric";

// A0a — the asymmetric (public-key) verify primitives. This file covers Ed25519 (Discord, Telnyx);
// ECDSA-P256 + RSA land with their providers. Anchored on Discord's reproduced gold vector: a 32-byte hex
// public key, the signed message `timestamp + rawBody` (no separator), and a 64-byte hex signature.

// Reproduced deterministic Discord vector (public key + signature over `1610000000{"type":1}`).
// PUBLIC reproduced Discord vector (an app public key + a signature) — not a private credential.
const PUB = hexToBytes(
  "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664", // gitleaks:allow
)!;
const SIG = hexToBytes(
  "50db4086e890c41c26b539f0dd95af18b4d8b03d2f4203964d238b4946943ee2cc6fd52c47ddb355d267086a8c4e299d1054d3d655dba6e0f237a779f634800d", // gitleaks:allow
)!;
const MSG = utf8Encoder.encode('1610000000{"type":1}');

describe("verifyEd25519", () => {
  it("verifies a valid Ed25519 signature (Discord gold vector)", async () => {
    expect(await verifyEd25519(PUB, MSG, SIG)).toBe(true);
  });

  it("rejects a tampered message", async () => {
    expect(await verifyEd25519(PUB, utf8Encoder.encode('1610000000{"type":2}'), SIG)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const bad = SIG.slice();
    bad[0] ^= 0xff;
    expect(await verifyEd25519(PUB, MSG, bad)).toBe(false);
  });

  it("rejects a signature made under a different key", async () => {
    const otherKey = hexToBytes(
      "0000000000000000000000000000000000000000000000000000000000000001",
    )!;
    expect(await verifyEd25519(otherKey, MSG, SIG)).toBe(false);
  });

  it("returns false (never throws) on wrong-length key or signature", async () => {
    expect(await verifyEd25519(PUB.slice(0, 31), MSG, SIG)).toBe(false);
    expect(await verifyEd25519(PUB, MSG, SIG.slice(0, 63))).toBe(false);
    expect(await verifyEd25519(new Uint8Array(0), MSG, SIG)).toBe(false);
  });
});
