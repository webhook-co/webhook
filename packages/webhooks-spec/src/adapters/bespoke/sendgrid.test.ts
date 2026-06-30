import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// SendGrid — ECDSA P-256/SHA-256 over `timestamp + rawBody`, base64 SPKI verification key, base64 DER
// signature. End-to-end through the registry on SendGrid's PUBLIC SDK gold vector (the body has a trailing
// CRLF; the crypto itself is also covered by asymmetric.test.ts).

const SIG_HEADER = "x-twilio-email-event-webhook-signature";
const TS_HEADER = "x-twilio-email-event-webhook-timestamp";
const KEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g=="; // gitleaks:allow
const SIG =
  "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM="; // gitleaks:allow
const TS = "1600112502";
const BODY =
  '[{"email":"hello@world.com","event":"dropped","reason":"Bounced Address","sg_event_id":"ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA","sg_message_id":"LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0","smtp-id":"<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>","timestamp":1600112492}]\r\n';
const NOW = new Date(1600112502 * 1000);

function input(overrides: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode(BODY),
    headers: [
      [SIG_HEADER, SIG],
      [TS_HEADER, TS],
    ] as [string, string][],
    secrets: [KEY],
    now: NOW,
    ...overrides,
  };
}

describe("sendgrid bespoke (ECDSA P-256 over timestamp+body, DER sig)", () => {
  it("exposes sendgrid metadata", () => {
    const adapter = getAdapterForScheme("sendgrid")!;
    expect(adapter.scheme).toBe("sendgrid");
    expect(adapter.signatureHeader).toBe(SIG_HEADER);
  });

  it("verifies the gold vector (DER sig + base64 SPKI key)", async () => {
    expect(await getAdapterForScheme("sendgrid")!.verify(input())).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "sendgrid",
    });
  });

  it("rejects a tampered body as SIGNATURE_MISMATCH", async () => {
    const result = await getAdapterForScheme("sendgrid")!.verify(
      input({ rawBody: utf8Encoder.encode("[]") }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("reports MISSING_HEADER when the timestamp header is absent", async () => {
    const result = await getAdapterForScheme("sendgrid")!.verify(
      input({ headers: [[SIG_HEADER, SIG]] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });

  it("reports MALFORMED_SIGNATURE for a non-DER signature", async () => {
    const result = await getAdapterForScheme("sendgrid")!.verify(
      input({
        headers: [
          [SIG_HEADER, "bm90LWRlcg=="], // base64 of "not-der" — decodes but isn't a DER SEQUENCE
          [TS_HEADER, TS],
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
