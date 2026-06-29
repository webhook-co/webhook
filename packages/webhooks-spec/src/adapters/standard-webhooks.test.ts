import { describe, expect, it } from "vitest";

import { b64ToBytes, hmacSha256, utf8Encoder } from "../bytes";
import { standardWebhooksAdapter } from "./standard-webhooks";
import { MAX_VERIFIABLE_BODY_BYTES } from "./shared";

// base64-encode bytes (standard alphabet, padded). Test-local: production only needs DECODE.
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Sign per the Standard Webhooks v1 construction: key = base64-decode(secret minus `whsec_`);
// message = `{id}.{ts}.{body}`; MAC = base64(HMAC-SHA256). Returns a `v1,<b64>` entry.
async function signSW(id: string, ts: number, body: string, secret: string): Promise<string> {
  const key = b64ToBytes(secret.replace(/^whsec_/, ""));
  if (key === null) throw new Error("test secret is not valid base64");
  const mac = await hmacSha256(key, utf8Encoder.encode(`${id}.${ts}.${body}`));
  return `v1,${bytesToB64(mac)}`;
}

// A valid `whsec_`-prefixed secret (32 random bytes, base64) for the rotation cases.
const SECRET = `whsec_${bytesToB64(utf8Encoder.encode("a-standard-webhooks-secret-32byte"))}`;
const ROTATED = `whsec_${bytesToB64(utf8Encoder.encode("an-older-rotated-sw-secret-32byte"))}`;

const ID = "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W";
const BODY = '{"event":"order.created","id":"ord_1"}';
const NOW = new Date("2026-06-13T00:00:00Z");
const TS = Math.floor(NOW.getTime() / 1000);

function headers(
  sig: string,
  id = ID,
  ts: string = String(TS),
): ReadonlyArray<readonly [string, string]> {
  return [
    ["content-type", "application/json"],
    ["webhook-id", id],
    ["webhook-timestamp", ts],
    ["webhook-signature", sig],
  ];
}

describe("standardWebhooksAdapter", () => {
  it("exposes scheme metadata", () => {
    expect(standardWebhooksAdapter.scheme).toBe("standard_webhooks");
    expect(standardWebhooksAdapter.signatureHeader).toBe("webhook-signature");
    expect(standardWebhooksAdapter.toleranceSeconds).toBe(300);
  });

  it("reports MALFORMED (structural reason) when a stale timestamp coincides with no v1 signature", async () => {
    // A doubly-malformed request: the timestamp is outside the replay window AND the signature
    // header carries no `v1` entry. The config-driven factory surfaces the structural problem
    // (MALFORMED_SIGNATURE) before the replay-window check — one consistent diagnosis order across
    // every provider. (Both outcomes reject; this just pins which reason wins.)
    const stale = String(TS - 10_000); // well outside the 300s window
    const noV1 = `v1a,${bytesToB64(new Uint8Array(64))}`; // asymmetric-only entry: no v1
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(noV1, ID, stale),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  // The gold byte-correctness anchor: the published spec vector (independently recomputed).
  // https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
  it("verifies the Standard Webhooks spec vector (byte-correctness)", async () => {
    const vec = {
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      ts: 1614265330,
      body: '{"test": 2432232314}',
      secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", // gitleaks:allow — public Standard Webhooks spec test vector, not a real secret
      sig: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    };
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(vec.body),
      headers: headers(vec.sig, vec.id, String(vec.ts)),
      secrets: [vec.secret],
      now: new Date(vec.ts * 1000 + 1000), // within tolerance of the vector's own timestamp
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "standard_webhooks" });
  });

  it("verifies a known-answer signature and reports the matching key", async () => {
    const sig = await signSW(ID, TS, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "standard_webhooks" });
  });

  it("accepts a rotated (older) secret", async () => {
    const sig = await signSW(ID, TS, BODY, ROTATED);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: [SECRET, ROTATED],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_1", scheme: "standard_webhooks" });
  });

  it("accepts any matching entry in a space-delimited multi-signature header", async () => {
    const good = await signSW(ID, TS, BODY, SECRET);
    const bogus = `v1,${bytesToB64(new Uint8Array(32))}`; // 32 zero bytes, wrong MAC
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(`${bogus} ${good}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("ignores asymmetric v1a entries and requires a v1 match", async () => {
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(`v1a,${bytesToB64(new Uint8Array(64))}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses a missing signature header", async () => {
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["webhook-id", ID],
        ["webhook-timestamp", String(TS)],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "webhook-signature", scheme: "standard_webhooks" },
    });
  });

  it("diagnoses a missing webhook-id", async () => {
    const sig = await signSW(ID, TS, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["webhook-timestamp", String(TS)],
        ["webhook-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses a missing webhook-timestamp", async () => {
    const sig = await signSW(ID, TS, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["webhook-id", ID],
        ["webhook-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses a non-integer webhook-timestamp", async () => {
    const sig = await signSW(ID, TS, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig, ID, "not-a-number"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("rejects a too-old timestamp before spending HMAC cycles", async () => {
    const oldTs = TS - 600;
    const sig = await signSW(ID, oldTs, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig, ID, String(oldTs)),
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

  it("rejects a future timestamp", async () => {
    const futureTs = TS + 600;
    const sig = await signSW(ID, futureTs, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig, ID, String(futureTs)),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_IN_FUTURE");
  });

  it("flags WRONG_SECRET when the signature shape is right but no secret matches", async () => {
    const sig = await signSW(
      ID,
      TS,
      BODY,
      `whsec_${bytesToB64(utf8Encoder.encode("some-entirely-other-secret-here"))}`,
    );
    const result = await standardWebhooksAdapter.verify({
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

  it("flags RAW_BODY_MODIFIED when a trailing byte was added in transit", async () => {
    const sig = await signSW(ID, TS, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(`${BODY}\n`),
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

  it("diagnoses a malformed base64 signature", async () => {
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers("v1,@@@not-base64@@@"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("diagnoses a header with no v1 entries", async () => {
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers("v2,abc def,ghi"),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("skips a whsec_-only (zero-length key) secret and matches a later real one", async () => {
    const sig = await signSW(ID, TS, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: ["whsec_", SECRET], // first decodes to an empty key → skipped, not thrown
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_1", scheme: "standard_webhooks" });
  });

  it("reports NO_MATCHING_KEY (never throws) when every secret has a zero-length key", async () => {
    const sig = await signSW(ID, TS, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(sig),
      secrets: ["whsec_"],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("NO_MATCHING_KEY");
  });

  it("verifies a valid entry regardless of its position among many entries (no false-reject)", async () => {
    const good = await signSW(ID, TS, BODY, SECRET);
    const bogus = `v1,${bytesToB64(new Uint8Array(32))}`;
    // The valid signature is the 51st entry; multi-sig verification must still find it.
    const entries = [...Array(50).fill(bogus), good];
    const result = await standardWebhooksAdapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: headers(entries.join(" ")),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("reports NO_MATCHING_KEY when no secrets are registered", async () => {
    const sig = await signSW(ID, TS, BODY, SECRET);
    const result = await standardWebhooksAdapter.verify({
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
    const result = await standardWebhooksAdapter.verify({
      rawBody: huge,
      headers: headers(`v1,${bytesToB64(new Uint8Array(32))}`),
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
