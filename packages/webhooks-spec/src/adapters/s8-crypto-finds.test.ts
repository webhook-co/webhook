import { describe, expect, it } from "vitest";

import { b64ToBytes, bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// S8 coverage — crypto providers surfaced while researching the token-tier (they actually SIGN, so they
// belong here, not in the non-crypto tier). Doc-verified 2026-07-01:
//   raw-body base64 : tally (`Tally-Signature`)
//   Standard Webhooks: loops (`webhook-*` trio)
//   framed          : customer_io (`v0:{ts}:{body}` Slack-style, `X-CIO-Timestamp`)
//                     · framer (`{body}{submissionId}` — body ++ the `Framer-Webhook-Submission-Id` header,
//                       no separator, `sha256=` hex prefix)
// Miro is DEFERRED — no official signature spec exists (third-party sources only); it needs a live capture.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
async function macHex(secret: string, message: string): Promise<string> {
  return bytesToHex(await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(message)));
}
async function macB64(secret: string, message: string): Promise<string> {
  return bytesToB64(await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(message)));
}

const SECRET = "an-s8-crypto-finds-secret"; // gitleaks:allow — fabricated test fixture
const BODY_STR = '{"event":"form.submitted","id":"f_1"}';
const BODY = utf8Encoder.encode(BODY_STR);
const TS = 1_790_000_000;
const NOW = new Date(TS * 1000 + 1000);

describe("tally — raw-body HMAC-SHA256 / base64", () => {
  it("verifies a base64 HMAC over the raw body", async () => {
    const sig = await macB64(SECRET, BODY_STR);
    const result = await getAdapterForScheme("tally")!.verify({
      rawBody: BODY,
      headers: [["tally-signature", sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "tally" });
  });

  it("rejects a tampered body", async () => {
    const sig = await macB64(SECRET, BODY_STR);
    const result = await getAdapterForScheme("tally")!.verify({
      rawBody: utf8Encoder.encode('{"event":"form.submitted","id":"TAMPERED"}'),
      headers: [["tally-signature", sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("loops — Standard Webhooks (webhook-* trio)", () => {
  const SW_SECRET = `whsec_${bytesToB64(utf8Encoder.encode("a-loops-standard-webhooks-32byte"))}`;
  it("verifies a Standard-Webhooks signature", async () => {
    const id = "msg_loops_1";
    const key = b64ToBytes(SW_SECRET.replace(/^whsec_/, ""))!;
    const mac = await hmacSha256(key, utf8Encoder.encode(`${id}.${TS}.${BODY_STR}`));
    const sig = `v1,${bytesToB64(mac)}`;
    const result = await getAdapterForScheme("loops")!.verify({
      rawBody: BODY,
      headers: [
        ["webhook-id", id],
        ["webhook-timestamp", String(TS)],
        ["webhook-signature", sig],
      ],
      secrets: [SW_SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "loops" });
  });
});

describe("customer_io — v0:{ts}:{body} (Slack-style)", () => {
  it("verifies HMAC-SHA256/hex over `v0:{ts}:{body}`", async () => {
    const sig = await macHex(SECRET, `v0:${TS}:${BODY_STR}`);
    const result = await getAdapterForScheme("customer_io")!.verify({
      rawBody: BODY,
      headers: [
        ["x-cio-timestamp", String(TS)],
        ["x-cio-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "customer_io" });
  });

  it("rejects a wrong-prefix signature (guards the v0: framing)", async () => {
    const sig = await macHex(SECRET, `${TS}:${BODY_STR}`); // missing `v0:`
    const result = await getAdapterForScheme("customer_io")!.verify({
      rawBody: BODY,
      headers: [
        ["x-cio-timestamp", String(TS)],
        ["x-cio-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("framer — {body}{submissionId} + sha256= prefix", () => {
  const SUBMISSION_ID = "sub_abc123";
  it("verifies HMAC-SHA256/hex over body ++ submissionId with a sha256= prefix", async () => {
    const sig = `sha256=${await macHex(SECRET, `${BODY_STR}${SUBMISSION_ID}`)}`;
    const result = await getAdapterForScheme("framer")!.verify({
      rawBody: BODY,
      headers: [
        ["framer-webhook-submission-id", SUBMISSION_ID],
        ["framer-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "framer" });
  });

  it("rejects a signature that omits the submission id (guards the concat)", async () => {
    const sig = `sha256=${await macHex(SECRET, BODY_STR)}`; // body only
    const result = await getAdapterForScheme("framer")!.verify({
      rawBody: BODY,
      headers: [
        ["framer-webhook-submission-id", SUBMISSION_ID],
        ["framer-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});
