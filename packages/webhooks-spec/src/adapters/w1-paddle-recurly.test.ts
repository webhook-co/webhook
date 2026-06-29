import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import type { WebhookScheme } from "../scheme";
import { getAdapterForScheme } from "./registry";

// paddle: `Paddle-Signature: ts=<unix>;h1=<hex>` (SEMICOLON-delimited csvKv), signed `{ts}:{body}`.
// recurly: `recurly-signature: <unix>,<sig1>,<sig2>` (POSITIONAL: first element = timestamp, rest =
// signatures during key rotation), signed `{ts}.{body}`. Both unix-seconds, hex, utf8 key.

const SECRET = "a-test-signing-secret";
const BODY = '{"event":"test","id":"evt_5"}';
const TS = 1790000000;
const NOW = new Date(TS * 1000 + 1000);

type HeaderPairs = ReadonlyArray<readonly [string, string]>;
interface Case {
  readonly slug: WebhookScheme;
  readonly sigHeader: string;
  readonly headers: (ts: string, sig: string) => HeaderPairs;
  readonly msg: (ts: string, body: string) => string;
}

const CASES: readonly Case[] = [
  {
    slug: "paddle",
    sigHeader: "paddle-signature",
    headers: (ts, sig) => [["paddle-signature", `ts=${ts};h1=${sig}`]],
    msg: (ts, body) => `${ts}:${body}`,
  },
  {
    slug: "recurly",
    sigHeader: "recurly-signature",
    headers: (ts, sig) => [["recurly-signature", `${ts},${sig}`]],
    msg: (ts, body) => `${ts}.${body}`,
  },
];

async function signHex(secret: string, signed: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(signed));
  return bytesToHex(mac);
}

describe("W1 paddle + recurly (semicolon / positional CSV)", () => {
  for (const c of CASES) {
    describe(c.slug, () => {
      it(`exposes ${c.sigHeader} metadata`, () => {
        const adapter = getAdapterForScheme(c.slug)!;
        expect(adapter.scheme).toBe(c.slug);
        expect(adapter.signatureHeader).toBe(c.sigHeader);
      });

      it("verifies a correctly-signed event", async () => {
        const sig = await signHex(SECRET, c.msg(String(TS), BODY));
        const result = await getAdapterForScheme(c.slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [["content-type", "application/json"], ...c.headers(String(TS), sig)],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: c.slug });
      });

      it("rejects a stale timestamp (replay window)", async () => {
        const stale = String(TS - 100_000);
        const sig = await signHex(SECRET, c.msg(stale, BODY));
        const result = await getAdapterForScheme(c.slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [["content-type", "application/json"], ...c.headers(stale, sig)],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
      });
    });
  }

  it("recurly verifies when one of several rotated signatures matches", async () => {
    const sig = await signHex(SECRET, `${TS}.${BODY}`);
    const result = await getAdapterForScheme("recurly")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      // First listed signature is junk (a stale-key sig); the second is the valid one.
      headers: [["recurly-signature", `${TS},${"a".repeat(64)},${sig}`]],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(true);
  });
});
