import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import { getAdapterForScheme } from "./registry";

// S8 coverage — the "any-of-N candidate signatures" rotation knob. Three providers ship multiple valid
// signatures at once (during key rotation) and require accept-if-any:
//   box       — TWO fixed headers `box-signature-primary` + `box-signature-secondary`, each an independent
//               base64 HMAC-SHA256 over `{body}{box-delivery-timestamp}` (body first, no separator).
//   configcat — ONE header `x-configcat-webhook-signature-v1` carrying COMMA-joined bare base64 digests,
//               HMAC-SHA256 over `{id}{timestamp}{body}` (no separators).
//   persona   — ONE header `persona-signature` carrying SPACE-separated `t=..,v1=..` groups (Stripe-shaped),
//               hex HMAC-SHA256 over `{t}.{body}`. (Single-group, non-rotation, must still verify.)
// The verify loop already tries every collected signature × every registered secret; this batch just
// teaches the factory to COLLECT the multiple candidates. All secrets below are fabricated fixtures.

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

const KEY_A = "s8-rot-secret-A"; // gitleaks:allow — fake test fixture
const KEY_B = "s8-rot-secret-B"; // gitleaks:allow — fake test fixture
const BODY_STR = '{"event":"rotate.test","id":"r_1"}';
const BODY = utf8Encoder.encode(BODY_STR);
const TS = 1_790_000_000;
const NOW = new Date(TS * 1000 + 1000);

describe("box — dual primary/secondary header (rotation)", () => {
  const ISO = "2020-10-29T18:39:59-07:00";
  const headers = (primarySig: string, secondarySig?: string) => {
    const h: [string, string][] = [
      ["box-delivery-timestamp", ISO],
      ["box-signature-primary", primarySig],
    ];
    if (secondarySig !== undefined) h.push(["box-signature-secondary", secondarySig]);
    return h;
  };
  const msg = `${BODY_STR}${ISO}`;

  it("verifies the primary signature (base64, body ++ delivery-timestamp)", async () => {
    const result = await getAdapterForScheme("box")!.verify({
      rawBody: BODY,
      headers: headers(await macB64(KEY_A, msg)),
      secrets: [KEY_A],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "box" });
  });

  it("accepts during rotation: primary signed with the NEW key, secondary with the OLD key", async () => {
    // Operator has both keys registered; Box signs primary with B (new) and secondary with A (old).
    const result = await getAdapterForScheme("box")!.verify({
      rawBody: BODY,
      headers: headers(await macB64(KEY_B, msg), await macB64(KEY_A, msg)),
      secrets: [KEY_A, KEY_B],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a tampered body (neither header matches)", async () => {
    const result = await getAdapterForScheme("box")!.verify({
      rawBody: utf8Encoder.encode('{"event":"rotate.test","id":"TAMPERED"}'),
      headers: headers(await macB64(KEY_A, msg), await macB64(KEY_B, msg)),
      secrets: [KEY_A, KEY_B],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("configcat — comma-joined bare digests (rotation)", () => {
  const headers = (sigValue: string) => [
    ["x-configcat-webhook-id", "wh_1"],
    ["x-configcat-webhook-timestamp", String(TS)],
    ["x-configcat-webhook-signature-v1", sigValue],
  ];
  const msg = `wh_1${TS}${BODY_STR}`; // {id}{ts}{body}, no separators

  it("verifies a single base64 digest", async () => {
    const result = await getAdapterForScheme("configcat")!.verify({
      rawBody: BODY,
      headers: headers(await macB64(KEY_A, msg)),
      secrets: [KEY_A],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "configcat" });
  });

  it("accepts during rotation: two comma-joined digests, either can match a registered secret", async () => {
    const sigValue = `${await macB64(KEY_B, msg)},${await macB64(KEY_A, msg)}`;
    const result = await getAdapterForScheme("configcat")!.verify({
      rawBody: BODY,
      headers: headers(sigValue),
      secrets: [KEY_A],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when no comma-joined digest matches", async () => {
    const sigValue = `${await macB64(KEY_B, msg)},${await macB64("nope", msg)}`;
    const result = await getAdapterForScheme("configcat")!.verify({
      rawBody: BODY,
      headers: headers(sigValue),
      secrets: [KEY_A],
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("persona — space-separated csvKv groups (rotation)", () => {
  const msg = `${TS}.${BODY_STR}`;
  const header = (value: string): [string, string][] => [["persona-signature", value]];

  it("still verifies a single `t=..,v1=..` group (regression)", async () => {
    const sig = await macHex(KEY_A, msg);
    const result = await getAdapterForScheme("persona")!.verify({
      rawBody: BODY,
      headers: header(`t=${TS},v1=${sig}`),
      secrets: [KEY_A],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "persona" });
  });

  it("accepts during rotation: two space-separated groups, either v1 can match", async () => {
    const sigA = await macHex(KEY_A, msg);
    const sigB = await macHex(KEY_B, msg);
    // sigA (the one that matches KEY_A) is in the FIRST group — the current comma-only parser corrupts
    // the middle token (`v1=<sigA> t=<ts>`), so this only passes once the space-group parsing lands.
    const result = await getAdapterForScheme("persona")!.verify({
      rawBody: BODY,
      headers: header(`t=${TS},v1=${sigA} t=${TS},v1=${sigB}`),
      secrets: [KEY_A],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});
