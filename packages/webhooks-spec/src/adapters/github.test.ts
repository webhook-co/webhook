import { describe, expect, it } from "vitest";

import { hmacSha256, bytesToHex, utf8Encoder } from "../bytes";
import { githubAdapter } from "./github";

const SECRET = "gh_webhook_secret";
const ROTATED = "gh_rotated_secret";
const BODY = '{"action":"opened","number":1}';
const NOW = new Date("2026-06-13T00:00:00Z");

async function signGithub(body: string, secret: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(body));
  return `sha256=${bytesToHex(mac)}`;
}

function headers(sig: string): ReadonlyArray<readonly [string, string]> {
  return [
    ["content-type", "application/json"],
    ["X-Hub-Signature-256", sig],
  ];
}

describe("githubAdapter", () => {
  it("exposes scheme metadata", () => {
    expect(githubAdapter.scheme).toBe("github");
    expect(githubAdapter.signatureHeader).toBe("x-hub-signature-256");
  });

  it("verifies a known-answer signature", async () => {
    const sig = await signGithub(BODY, SECRET);
    const result = await githubAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "github" });
  });

  it("accepts a rotated secret", async () => {
    const sig = await signGithub(BODY, ROTATED);
    const result = await githubAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_1", scheme: "github" });
  });

  it("diagnoses a missing signature header", async () => {
    const result = await githubAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["content-type", "application/json"]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "x-hub-signature-256", scheme: "github" },
    });
  });

  it("diagnoses a malformed header (missing sha256= prefix)", async () => {
    const result = await githubAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers("deadbeef"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("flags WRONG_SECRET when shape is right but no secret matches", async () => {
    const sig = await signGithub(BODY, "totally_unrelated_secret");
    const result = await githubAdapter.verify({
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

  it("flags RAW_BODY_MODIFIED when the JSON was re-serialized in transit", async () => {
    // Sender signed COMPACT JSON; a proxy pretty-printed it before we captured it. Our
    // re-encode probe (parse → compact) recovers the signed bytes, so we can prove the
    // body was mutated rather than guess WRONG_SECRET.
    const compact = JSON.stringify({ action: "opened", number: 1 });
    const sig = await signGithub(compact, SECRET);
    const prettied = JSON.stringify({ action: "opened", number: 1 }, null, 2); // captured
    const result = await githubAdapter.verify({
      rawBody: utf8Encoder.encode(prettied),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("RAW_BODY_MODIFIED");
      if (result.reason.code === "RAW_BODY_MODIFIED") {
        expect(result.reason.evidence).toBe("reencoded_json");
      }
    }
  });

  it("flags RAW_BODY_MODIFIED on a single mutated body byte (trailing whitespace)", async () => {
    const sig = await signGithub(BODY, SECRET);
    const mutated = utf8Encoder.encode(`${BODY} `);
    const result = await githubAdapter.verify({
      rawBody: mutated,
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("RAW_BODY_MODIFIED");
  });

  it("falls back to SIGNATURE_MISMATCH for a non-hex digest", async () => {
    const result = await githubAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers("sha256=not-hex"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("ignores the (unused) timestamp tolerance — no temporal failures", async () => {
    // GitHub has no signed timestamp; an arbitrarily old `now` must not fail temporally.
    const sig = await signGithub(BODY, SECRET);
    const result = await githubAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: new Date("2030-01-01T00:00:00Z"),
    });
    expect(result.ok).toBe(true);
  });

  it("diagnoses an oversized body without attempting the HMAC", async () => {
    const huge = new Uint8Array(1024 * 1024 + 1);
    const result = await githubAdapter.verify({
      rawBody: huge,
      headers: headers(`sha256=${"a".repeat(64)}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("reports NO_MATCHING_KEY when no secrets are registered", async () => {
    const sig = await signGithub(BODY, SECRET);
    const result = await githubAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });
});
