import { describe, expect, it } from "vitest";

import { b64ToBytes, bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// S8 coverage — HMAC long-tail (doc-verified 2026-07-01):
//   raw-body : ashby (hex, `sha256=`) · merge_dev (base64url) · cronofy (base64, comma delimitedList)
//   Standard Webhooks: increase (`webhook-*`) · finch (`Finch-*` headers, BARE-base64 secret)
//   framed   : knock (csvKv `t=,s=`, base64, `{ts}.{body}`, ms ts) · deel (`"POST"+body`, hex)
// Deferred: fireblocks (RSA/JWKS asymmetric), posthog (no built-in signing), rippling (undocumented),
// statsig (signature header name unconfirmed), column (hex-vs-base64 encoding unconfirmed).

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
const bytesToB64url = (b: Uint8Array): string =>
  bytesToB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function mac(secret: string | Uint8Array, message: string): Promise<Uint8Array> {
  const key = typeof secret === "string" ? utf8Encoder.encode(secret) : secret;
  return hmacSha256(key, utf8Encoder.encode(message));
}

const SECRET = "an-s8-longtail-secret"; // gitleaks:allow — fabricated test fixture
const BODY_STR = '{"event":"longtail.test","id":"lt_1"}';
const BODY = utf8Encoder.encode(BODY_STR);
const TS = 1_790_000_000;
const NOW = new Date(TS * 1000 + 1000);

describe("ashby — raw-body sha256/hex, sha256= prefix", () => {
  it("verifies", async () => {
    const sig = `sha256=${bytesToHex(await mac(SECRET, BODY_STR))}`;
    const result = await getAdapterForScheme("ashby")!.verify({
      rawBody: BODY,
      headers: [["ashby-signature", sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "ashby" });
  });
});

describe("merge_dev — raw-body sha256/base64url", () => {
  it("verifies (base64url, not base64)", async () => {
    const sig = bytesToB64url(await mac(SECRET, BODY_STR));
    const result = await getAdapterForScheme("merge_dev")!.verify({
      rawBody: BODY,
      headers: [["x-merge-webhook-signature", sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "merge_dev" });
  });
});

describe("cronofy — comma delimitedList of base64 HMACs (rotation)", () => {
  it("verifies when the computed HMAC is one of the comma-listed digests", async () => {
    const sigValue = `${bytesToB64(await mac("other-secret", BODY_STR))},${bytesToB64(await mac(SECRET, BODY_STR))}`;
    const result = await getAdapterForScheme("cronofy")!.verify({
      rawBody: BODY,
      headers: [["cronofy-hmac-sha256", sigValue]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe("increase — Standard Webhooks (webhook-* trio)", () => {
  const SW_SECRET = `whsec_${bytesToB64(utf8Encoder.encode("increase-standard-webhooks-32byt"))}`;
  it("verifies", async () => {
    const id = "msg_inc_1";
    const key = b64ToBytes(SW_SECRET.replace(/^whsec_/, ""))!;
    const sig = `v1,${bytesToB64(await mac(key, `${id}.${TS}.${BODY_STR}`))}`;
    const result = await getAdapterForScheme("increase")!.verify({
      rawBody: BODY,
      headers: [
        ["webhook-id", id],
        ["webhook-timestamp", String(TS)],
        ["webhook-signature", sig],
      ],
      secrets: [SW_SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "increase" });
  });
});

describe("finch — SW-shaped with Finch-* headers + bare-base64 secret", () => {
  const BARE_SECRET = bytesToB64(utf8Encoder.encode("finch-bare-base64-secret-32bytes")); // no whsec_
  it("verifies over finch-event-id.finch-timestamp.body", async () => {
    const id = "evt_finch_1";
    const key = b64ToBytes(BARE_SECRET)!;
    const sig = `v1,${bytesToB64(await mac(key, `${id}.${TS}.${BODY_STR}`))}`;
    const result = await getAdapterForScheme("finch")!.verify({
      rawBody: BODY,
      headers: [
        ["finch-event-id", id],
        ["finch-timestamp", String(TS)],
        ["finch-signature", sig],
      ],
      secrets: [BARE_SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "finch" });
  });
});

describe("knock — csvKv `t=,s=`, base64, {ts}.{body}, millisecond ts", () => {
  it("verifies", async () => {
    const tsMs = TS * 1000; // Knock's `t` is in milliseconds
    const sig = bytesToB64(await mac(SECRET, `${tsMs}.${BODY_STR}`));
    const result = await getAdapterForScheme("knock")!.verify({
      rawBody: BODY,
      headers: [["x-knock-signature", `t=${tsMs},s=${sig}`]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "knock" });
  });
});

describe("deel — `POST` literal prefixed to the body", () => {
  it("verifies HMAC over `POST` ++ body (hex)", async () => {
    const sig = bytesToHex(await mac(SECRET, `POST${BODY_STR}`));
    const result = await getAdapterForScheme("deel")!.verify({
      rawBody: BODY,
      headers: [["x-deel-signature", sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "deel" });
  });

  it("rejects a signature over the bare body (guards the POST prefix)", async () => {
    const sig = bytesToHex(await mac(SECRET, BODY_STR));
    const result = await getAdapterForScheme("deel")!.verify({
      rawBody: BODY,
      headers: [["x-deel-signature", sig]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});
