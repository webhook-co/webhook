import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import type { WebhookScheme } from "../scheme";
import { getAdapterForScheme } from "./registry";

// The timestamp-format extension: providers whose signed timestamp is NOT integer-seconds.
//  - workos / front: MILLISECONDS (the raw ms string is signed; the replay window uses ms/1000).
//  - zendesk / twitch: ISO-8601 / RFC3339 DATETIME (the raw string is signed; Date.parse drives the
//    replay window). These KATs deliberately use each provider's REAL timestamp format — a
//    self-consistent integer-timestamp KAT would NOT have caught the bug these configs fix.

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const SECRET = "a-test-signing-secret";
const BODY = '{"event":"test","id":"evt_4"}';
const EPOCH = 1790000000; // a reference unix-seconds instant the cases build their timestamps around
const TWITCH_ID = "twitch-msg-9f8e7d";

type HeaderPairs = ReadonlyArray<readonly [string, string]>;
interface Case {
  readonly slug: WebhookScheme;
  readonly sigHeader: string;
  readonly enc: "hex" | "base64";
  readonly fmt: "ms" | "datetime";
  /** A valid timestamp string in the provider's format, at EPOCH. */
  readonly ts: string;
  readonly headers: (ts: string, sig: string) => HeaderPairs;
  readonly msg: (ts: string, body: string) => string;
}

const CASES: readonly Case[] = [
  {
    slug: "workos",
    sigHeader: "workos-signature",
    enc: "hex",
    fmt: "ms",
    ts: String(EPOCH * 1000),
    headers: (ts, sig) => [["workos-signature", `t=${ts},v1=${sig}`]],
    msg: (ts, body) => `${ts}.${body}`,
  },
  {
    slug: "front",
    sigHeader: "x-front-signature",
    enc: "base64",
    fmt: "ms",
    ts: String(EPOCH * 1000),
    headers: (ts, sig) => [
      ["x-front-request-timestamp", ts],
      ["x-front-signature", sig],
    ],
    msg: (ts, body) => `${ts}:${body}`,
  },
  {
    slug: "zendesk",
    sigHeader: "x-zendesk-webhook-signature",
    enc: "base64",
    fmt: "datetime",
    ts: new Date(EPOCH * 1000).toISOString(), // e.g. 2026-09-...T...Z
    headers: (ts, sig) => [
      ["x-zendesk-webhook-signature-timestamp", ts],
      ["x-zendesk-webhook-signature", sig],
    ],
    msg: (ts, body) => `${ts}${body}`,
  },
  {
    slug: "twitch",
    sigHeader: "twitch-eventsub-message-signature",
    enc: "hex",
    fmt: "datetime",
    ts: new Date(EPOCH * 1000).toISOString().replace("Z", "634234626Z"), // RFC3339 w/ sub-second digits
    headers: (ts, sig) => [
      ["twitch-eventsub-message-id", TWITCH_ID],
      ["twitch-eventsub-message-timestamp", ts],
      ["twitch-eventsub-message-signature", `sha256=${sig}`],
    ],
    msg: (ts, body) => `${TWITCH_ID}${ts}${body}`,
  },
];

async function signEnc(enc: "hex" | "base64", secret: string, signed: string): Promise<string> {
  const mac = await hmacSha256(utf8Encoder.encode(secret), utf8Encoder.encode(signed));
  return enc === "hex" ? bytesToHex(mac) : bytesToB64(mac);
}

/** A stale (far-past) timestamp in the case's format. */
function staleTs(fmt: "ms" | "datetime"): string {
  const staleMs = (EPOCH - 100_000) * 1000;
  return fmt === "ms" ? String(staleMs) : new Date(staleMs).toISOString();
}

const NOW = new Date(EPOCH * 1000 + 1000); // 1s after EPOCH — inside every window

describe("W1 timestamp-format providers (ms + datetime)", () => {
  for (const c of CASES) {
    describe(c.slug, () => {
      it(`exposes ${c.sigHeader} metadata`, () => {
        const adapter = getAdapterForScheme(c.slug)!;
        expect(adapter.scheme).toBe(c.slug);
        expect(adapter.signatureHeader).toBe(c.sigHeader);
      });

      it(`verifies over its ${c.fmt} timestamp`, async () => {
        const sig = await signEnc(c.enc, SECRET, c.msg(c.ts, BODY));
        const result = await getAdapterForScheme(c.slug)!.verify({
          rawBody: utf8Encoder.encode(BODY),
          headers: [["content-type", "application/json"], ...c.headers(c.ts, sig)],
          secrets: [SECRET],
          now: NOW,
        });
        expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: c.slug });
      });

      it("rejects a stale timestamp (replay window)", async () => {
        const stale = staleTs(c.fmt);
        const sig = await signEnc(c.enc, SECRET, c.msg(stale, BODY));
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

  it("a datetime provider rejects an unparseable timestamp as MALFORMED", async () => {
    const sig = await signEnc("base64", SECRET, `not-a-date${BODY}`);
    const result = await getAdapterForScheme("zendesk")!.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [
        ["x-zendesk-webhook-signature-timestamp", "not-a-date"],
        ["x-zendesk-webhook-signature", sig],
      ],
      secrets: [SECRET],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
