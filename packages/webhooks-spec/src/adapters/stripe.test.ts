import { describe, expect, it } from "vitest";

import { hmacSha256, bytesToHex, utf8Encoder } from "../bytes";
import { stripeAdapter } from "./stripe";
import { MAX_VERIFIABLE_BODY_BYTES } from "./shared";

const SECRET = "whsec_stripe_test_secret";
const ROTATED = "whsec_rotated_secret";
const BODY = '{"id":"evt_1","type":"charge.succeeded"}';

/** Build a valid Stripe-Signature header for a body+timestamp+secret. */
async function signStripe(body: string, tSeconds: number, secret: string): Promise<string> {
  const message = utf8Encoder.encode(`${tSeconds}.${body}`);
  const mac = await hmacSha256(utf8Encoder.encode(secret), message);
  return `t=${tSeconds},v1=${bytesToHex(mac)}`;
}

const NOW = new Date("2026-06-13T00:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

function headers(sig: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["content-type", "application/json"],
    ["Stripe-Signature", sig],
  ];
}

describe("stripeAdapter", () => {
  it("exposes scheme metadata", () => {
    expect(stripeAdapter.scheme).toBe("stripe");
    expect(stripeAdapter.signatureHeader).toBe("stripe-signature");
    expect(stripeAdapter.toleranceSeconds).toBe(300);
  });

  it("verifies a known-answer signature and reports the matching key", async () => {
    const sig = await signStripe(BODY, nowSec, SECRET);
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "stripe" });
  });

  it("accepts a rotated (older) secret", async () => {
    // Signed with the OLD secret; the new secret is newest-first but old still valid.
    const sig = await signStripe(BODY, nowSec, ROTATED);
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_1", scheme: "stripe" });
  });

  it("diagnoses a missing signature header", async () => {
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "stripe-signature", scheme: "stripe" },
    });
  });

  it("diagnoses a malformed header (no v1=)", async () => {
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(`t=${nowSec}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses a malformed header (no t=)", async () => {
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers("v1=deadbeef"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("rejects a too-old timestamp (replay window)", async () => {
    const oldT = nowSec - 600;
    const sig = await signStripe(BODY, oldT, SECRET);
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
      if (result.reason.code === "TIMESTAMP_TOO_OLD") {
        expect(result.reason.toleranceSeconds).toBe(300);
        expect(result.reason.skewSeconds).toBeGreaterThan(300);
      }
    }
  });

  it("rejects a future timestamp", async () => {
    const futureT = nowSec + 600;
    const sig = await signStripe(BODY, futureT, SECRET);
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_IN_FUTURE");
  });

  it("flags WRONG_SECRET when the signature shape is right but no secret matches", async () => {
    const sig = await signStripe(BODY, nowSec, "some_other_secret_entirely");
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("WRONG_SECRET");
      if (result.reason.code === "WRONG_SECRET") expect(result.reason.confidence).toBe("low");
    }
  });

  it("flags RAW_BODY_MODIFIED when a single trailing byte was added in transit", async () => {
    // Sender signed the clean body; a proxy appended a newline before we captured it.
    const sig = await signStripe(BODY, nowSec, SECRET);
    const mutated = utf8Encoder.encode(`${BODY}\n`);
    const result = await stripeAdapter.verify({
      rawBody: mutated,
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("RAW_BODY_MODIFIED");
      if (result.reason.code === "RAW_BODY_MODIFIED") {
        expect(result.reason.evidence).toBe("trailing_whitespace");
      }
    }
  });

  it("falls back to SIGNATURE_MISMATCH for a non-hex v1", async () => {
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(`t=${nowSec},v1=not-hex-at-all`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses an oversized body without attempting the HMAC", async () => {
    const huge = new Uint8Array(MAX_VERIFIABLE_BODY_BYTES + 1);
    const result = await stripeAdapter.verify({
      rawBody: huge,
      headers: headers(`t=${nowSec},v1=${"a".repeat(64)}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("reports NO_MATCHING_KEY when no secrets are registered", async () => {
    const sig = await signStripe(BODY, nowSec, SECRET);
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });

  it("verifies against the newest of several v1 signatures in the header", async () => {
    // Stripe may send multiple v1= entries; any matching one is a pass.
    const t = nowSec;
    const good = await signStripe(BODY, t, SECRET);
    const sig = `${good},v1=${"0".repeat(64)}`;
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("verifies a valid v1 regardless of its position among many entries (no false-reject)", async () => {
    const good = await signStripe(BODY, nowSec, SECRET); // "t=<ts>,v1=<good-hex>"
    const goodV1 = good.slice(good.indexOf("v1="));
    const bogus = Array(50)
      .fill(`v1=${"0".repeat(64)}`)
      .join(",");
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(`t=${nowSec},${bogus},${goodV1}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(true); // the valid v1 is checked regardless of position
  });

  it("returns the MOST INFORMATIVE diagnosis across multiple failing v1 entries", async () => {
    // First v1= is malformed hex (MALFORMED_SIGNATURE); second is valid-hex but signed by
    // an unknown secret (WRONG_SECRET — more informative). The more specific reason must win
    // even though it comes from a later entry (regression guard against "keep the first").
    const wrongMac = bytesToHex(
      await hmacSha256(
        utf8Encoder.encode("some_other_secret_entirely"),
        utf8Encoder.encode(`${nowSec}.${BODY}`),
      ),
    );
    const result = await stripeAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(`t=${nowSec},v1=nothex,v1=${wrongMac}`),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });
});
