import { describe, expect, it } from "vitest";

import { isUsableStandardWebhooksSecret } from "./adapters/shared";
import { standardWebhooksAdapter } from "./adapters/standard-webhooks";
import { utf8Encoder } from "./bytes";
import { generateSigningSecret, signStandardWebhooks } from "./sign";

// The send-side counterpart to standardWebhooksAdapter (the receiver). Byte-correctness is the whole
// point: the signer must produce exactly what the verifier accepts, so the tests are (1) the published
// Standard Webhooks KAT, independently recomputed, and (2) a round-trip through the real verifier.

const enc = (s: string) => utf8Encoder.encode(s);
const TS = Math.floor(new Date("2026-06-30T00:00:00Z").getTime() / 1000);

function headersOf(
  h: Record<string, string>,
  extra: ReadonlyArray<readonly [string, string]> = [],
): ReadonlyArray<readonly [string, string]> {
  return [
    ...extra,
    ["webhook-id", h["webhook-id"]!],
    ["webhook-timestamp", h["webhook-timestamp"]!],
    ["webhook-signature", h["webhook-signature"]!],
  ];
}

describe("signStandardWebhooks", () => {
  it("matches the published Standard Webhooks KAT (byte-for-byte)", async () => {
    // The canonical Svix/Standard-Webhooks vector, recomputed independently with node crypto:
    //   HMAC-SHA256( base64decode("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"),
    //                "msg_p5jXN8AQM9LWM0D4loKWxJek.1614265330.{\"test\": 2432232314}" ) -> base64
    const out = await signStandardWebhooks({
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: 1614265330,
      body: enc('{"test": 2432232314}'),
      secrets: ["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"],
    });
    expect(out["webhook-id"]).toBe("msg_p5jXN8AQM9LWM0D4loKWxJek");
    expect(out["webhook-timestamp"]).toBe("1614265330");
    expect(out["webhook-signature"]).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  it("round-trips through standardWebhooksAdapter.verify", async () => {
    const secret = generateSigningSecret();
    const id = "msg_roundtrip_1";
    const body = enc('{"hello":"world"}');
    const h = await signStandardWebhooks({ id, timestamp: TS, body, secrets: [secret] });
    const res = await standardWebhooksAdapter.verify({
      rawBody: body,
      headers: headersOf(h, [["content-type", "application/json"]]),
      secrets: [secret],
      now: new Date(TS * 1000),
    });
    expect(res).toEqual({ ok: true, keyId: "secret_0", scheme: "standard_webhooks" });
  });

  it("signs with multiple secrets (rotation overlap) — each verifies on its own", async () => {
    const fresh = generateSigningSecret();
    const old = generateSigningSecret();
    const id = "msg_rotation";
    const body = enc('{"n":1}');
    const h = await signStandardWebhooks({ id, timestamp: TS, body, secrets: [fresh, old] });

    const entries = h["webhook-signature"]!.split(" ");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.startsWith("v1,"))).toBe(true);

    const verifyWith = (secret: string) =>
      standardWebhooksAdapter.verify({
        rawBody: body,
        headers: headersOf(h),
        secrets: [secret],
        now: new Date(TS * 1000),
      });
    expect((await verifyWith(fresh)).ok).toBe(true);
    expect((await verifyWith(old)).ok).toBe(true);
  });

  it("a tampered body fails verification", async () => {
    const secret = generateSigningSecret();
    const id = "msg_tamper";
    const h = await signStandardWebhooks({
      id,
      timestamp: TS,
      body: enc('{"a":1}'),
      secrets: [secret],
    });
    const res = await standardWebhooksAdapter.verify({
      rawBody: enc('{"a":2}'),
      headers: headersOf(h),
      secrets: [secret],
      now: new Date(TS * 1000),
    });
    expect(res.ok).toBe(false);
  });

  it("throws when given no usable secret (strict — unlike verify, which skips)", async () => {
    await expect(
      signStandardWebhooks({ id: "x", timestamp: 1, body: enc("{}"), secrets: [] }),
    ).rejects.toThrow();
    await expect(
      signStandardWebhooks({
        id: "x",
        timestamp: 1,
        body: enc("{}"),
        secrets: ["not valid base64 !!!"],
      }),
    ).rejects.toThrow();
  });

  it("throws if ANY supplied secret is unusable — never silently drops one (partial-rotation safety)", async () => {
    // N secrets in -> N signatures out, or throw. Silently dropping a malformed retiring secret would
    // succeed while every receiver still pinned to it rejects the delivery (a silent partial-rotation
    // failure). So a usable fresh secret paired with a malformed one must fail loudly, not sign with one.
    const fresh = generateSigningSecret();
    await expect(
      signStandardWebhooks({
        id: "x",
        timestamp: TS,
        body: enc("{}"),
        secrets: [fresh, "not valid base64 !!!"],
      }),
    ).rejects.toThrow();
  });
});

describe("generateSigningSecret", () => {
  it("produces a usable whsec_ secret, unique per call", () => {
    const a = generateSigningSecret();
    const b = generateSigningSecret();
    expect(a.startsWith("whsec_")).toBe(true);
    expect(isUsableStandardWebhooksSecret(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});
