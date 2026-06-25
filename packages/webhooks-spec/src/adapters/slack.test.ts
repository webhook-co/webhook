import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import { slackAdapter } from "./slack";
import { MAX_VERIFIABLE_BODY_BYTES } from "./shared";

// Slack signs `v0:{timestamp}:{rawBody}` with the signing secret (UTF-8), hex digest, `v0=` prefix.
// https://docs.slack.dev/authentication/verifying-requests-from-slack
async function signSlack(ts: number, body: string, secret: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(`v0:${ts}:${body}`));
  return `v0=${bytesToHex(mac)}`;
}

const SECRET = "slack_signing_secret_value";
const ROTATED = "slack_rotated_signing_secret";
const BODY = "payload=%7B%22type%22%3A%22event_callback%22%7D";
const NOW = new Date("2026-06-13T00:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);

function headers(sig: string, ts: string = String(TS)): ReadonlyArray<readonly [string, string]> {
  return [
    ["content-type", "application/x-www-form-urlencoded"],
    ["X-Slack-Request-Timestamp", ts],
    ["X-Slack-Signature", sig],
  ];
}

describe("slackAdapter", () => {
  it("exposes scheme metadata", () => {
    expect(slackAdapter.scheme).toBe("slack");
    expect(slackAdapter.signatureHeader).toBe("x-slack-signature");
    expect(slackAdapter.toleranceSeconds).toBe(300);
  });

  // The gold byte-correctness anchor: Slack's published worked example (independently recomputed).
  it("verifies Slack's documented worked example (byte-correctness)", async () => {
    const vec = {
      secret: "8f742231b10e8888abcd99yyyzzz85a5", // gitleaks:allow — public Slack docs worked-example secret, not a real secret
      ts: 1531420618,
      body: "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
      sig: "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503",
    };
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(vec.body),
      headers: headers(vec.sig, String(vec.ts)),
      secrets: [vec.secret],
      now: new Date(vec.ts * 1000 + 1000), // within tolerance of the example's own timestamp
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "slack" });
  });

  it("verifies a known-answer signature and reports the matching key", async () => {
    const sig = await signSlack(TS, BODY, SECRET);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "slack" });
  });

  it("accepts a rotated (older) secret", async () => {
    const sig = await signSlack(TS, BODY, ROTATED);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_1", scheme: "slack" });
  });

  it("diagnoses a missing signature header", async () => {
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-slack-request-timestamp", String(TS)]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "x-slack-signature", scheme: "slack" },
    });
  });

  it("diagnoses a missing timestamp header", async () => {
    const sig = await signSlack(TS, BODY, SECRET);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-slack-signature", sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses a signature without the v0= prefix", async () => {
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(`${"a".repeat(64)}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses a non-integer timestamp", async () => {
    const sig = await signSlack(TS, BODY, SECRET);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig, "not-a-number"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("rejects a too-old timestamp before spending HMAC cycles (replay defense)", async () => {
    const oldTs = TS - 600;
    const sig = await signSlack(oldTs, BODY, SECRET);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig, String(oldTs)),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
      if (result.reason.code === "TIMESTAMP_TOO_OLD") {
        expect(result.reason.toleranceSeconds).toBe(300);
      }
    }
  });

  it("still enforces the replay window when now is an Invalid Date (NaN-skew guard)", async () => {
    // An Invalid Date (getTime() === NaN) must NOT silently disable the replay check.
    const oldTs = Math.floor(Date.now() / 1000) - 100_000;
    const sig = await signSlack(oldTs, BODY, SECRET);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig, String(oldTs)),
      secrets: [SECRET],
      now: new Date("not a real date"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });

  it("rejects a future timestamp", async () => {
    const futureTs = TS + 600;
    const sig = await signSlack(futureTs, BODY, SECRET);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig, String(futureTs)),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_IN_FUTURE");
  });

  it("flags WRONG_SECRET when shape is right but no secret matches", async () => {
    const sig = await signSlack(TS, BODY, "some_other_secret_entirely");
    const result = await slackAdapter.verify({
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

  it("falls back to MALFORMED_SIGNATURE for a non-hex digest", async () => {
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers("v0=not-hex-at-all"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("skips an empty secret without throwing (zero-length key)", async () => {
    const sig = await signSlack(TS, BODY, SECRET);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [""],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });

  it("reports NO_MATCHING_KEY when no secrets are registered", async () => {
    const sig = await signSlack(TS, BODY, SECRET);
    const result = await slackAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });

  it("diagnoses an oversized body without attempting the HMAC", async () => {
    const huge = new Uint8Array(MAX_VERIFIABLE_BODY_BYTES + 1);
    const result = await slackAdapter.verify({
      rawBody: huge,
      headers: headers(`v0=${"a".repeat(64)}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
