import { describe, expect, it } from "vitest";

import { bytesToHex, hmacSha256, utf8Encoder } from "../bytes";
import type { HmacProviderConfig, MessagePart } from "./config";
import { makeHmacAdapter } from "./factory";

// F3 — request-context message parts. Tier-2 providers sign over more than the body: the request URL
// (Square/Twilio/Trello), the HTTP method (HubSpot/Contentful), a query param (Mercado Pago), or
// form-field values (Mailgun token; Twilio/Mandrill sorted form params). These KATs drive
// makeHmacAdapter directly with a synthetic config per part, sign the expected message, and assert the
// adapter verifies — proving the part resolves from VerifyInput's requestUrl / method / rawBody.

const SECRET = "f3-secret";
const URL_FULL = "https://wbhk.my/abc123?id=42&topic=orders";
const BODY = '{"event":"f3"}';

function cfg(message: readonly MessagePart[]): HmacProviderConfig {
  return {
    slug: "github", // label only; makeHmacAdapter doesn't consult the registry
    signatureHeader: "x-f3-signature",
    encoding: "hex",
    message,
    toleranceSeconds: 300,
  };
}

async function signHex(message: string): Promise<string> {
  return bytesToHex(await hmacSha256(utf8Encoder.encode(SECRET), utf8Encoder.encode(message)));
}

interface Case {
  readonly name: string;
  readonly message: readonly MessagePart[];
  /** The exact string the provider signs, given the request context below. */
  readonly signed: string;
  readonly rawBody?: string;
}

const CASES: readonly Case[] = [
  {
    name: "url (full) + body — Square/Trello shape",
    message: [{ kind: "url", component: "full" }, { kind: "body" }],
    signed: `${URL_FULL}${BODY}`,
  },
  {
    name: "url (path) only — Contentful path component",
    message: [{ kind: "url", component: "path" }],
    signed: "/abc123",
  },
  {
    name: "method + url(full) + body — HubSpot shape",
    message: [{ kind: "method" }, { kind: "url", component: "full" }, { kind: "body" }],
    signed: `POST${URL_FULL}${BODY}`,
  },
  {
    name: "queryParam — Mercado Pago manifest field",
    message: [
      { kind: "literal", value: "id:" },
      { kind: "queryParam", name: "id" },
      { kind: "literal", value: ";" },
    ],
    signed: "id:42;",
  },
  {
    name: "formField — Mailgun {timestamp}{token}",
    message: [
      { kind: "formField", name: "timestamp" },
      { kind: "formField", name: "token" },
    ],
    signed: "1790000000abctoken",
    rawBody: "timestamp=1790000000&token=abctoken&signature=ignored",
  },
  {
    name: "sortedFormFields — Twilio/Mandrill (url + sorted key+value)",
    message: [{ kind: "url", component: "full" }, { kind: "sortedFormFields" }],
    // params sorted by key: Body, From -> "BodyHiFrom+15551234567"
    signed: `${URL_FULL}BodyHiFrom+15551234567`,
    rawBody: "From=%2B15551234567&Body=Hi",
  },
];

describe("F3 request-context message parts", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const sig = await signHex(c.signed);
      const adapter = makeHmacAdapter(cfg(c.message));
      const result = await adapter.verify({
        rawBody: utf8Encoder.encode(c.rawBody ?? BODY),
        headers: [["x-f3-signature", sig]],
        secrets: [SECRET],
        requestUrl: URL_FULL,
        method: "POST",
        now: new Date(1790000000 * 1000),
      });
      expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "github" });
    });
  }

  it("a url part with no requestUrl is MALFORMED (never throws)", async () => {
    const adapter = makeHmacAdapter(cfg([{ kind: "url", component: "full" }, { kind: "body" }]));
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode(BODY),
      headers: [["x-f3-signature", "deadbeef"]],
      secrets: [SECRET],
      // requestUrl omitted
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });

  it("an absent formField is MALFORMED (never throws)", async () => {
    const adapter = makeHmacAdapter(cfg([{ kind: "formField", name: "missing" }]));
    const result = await adapter.verify({
      rawBody: utf8Encoder.encode("other=1"),
      headers: [["x-f3-signature", "deadbeef"]],
      secrets: [SECRET],
      requestUrl: URL_FULL,
      method: "POST",
      now: new Date(1790000000 * 1000),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
