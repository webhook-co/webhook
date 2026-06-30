import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Discord interactions/webhooks — Ed25519 over `timestamp + rawBody` (no separator). Headers
// `X-Signature-Ed25519` (hex 64-byte sig) + `X-Signature-Timestamp`. The registered "secret" is the app's
// hex-encoded 32-byte public key. Anchored on Discord's reproduced gold vector.

// PUBLIC reproduced Discord vector (app public key + signature) — not a private credential.
const PUBKEY_HEX = "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"; // gitleaks:allow
const SIG_HEX =
  "50db4086e890c41c26b539f0dd95af18b4d8b03d2f4203964d238b4946943ee2cc6fd52c47ddb355d267086a8c4e299d1054d3d655dba6e0f237a779f634800d"; // gitleaks:allow
const TS = "1610000000";
const BODY = '{"type":1}';
const SIG_HEADER = "x-signature-ed25519";
const TS_HEADER = "x-signature-timestamp";
const NOW = new Date(1610000000 * 1000);

function input(overrides: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode(BODY),
    headers: [
      [SIG_HEADER, SIG_HEX],
      [TS_HEADER, TS],
    ] as [string, string][],
    secrets: [PUBKEY_HEX],
    now: NOW,
    ...overrides,
  };
}

describe("discord bespoke (Ed25519 over timestamp+body)", () => {
  it("exposes discord metadata", () => {
    const adapter = getAdapterForScheme("discord")!;
    expect(adapter.scheme).toBe("discord");
    expect(adapter.signatureHeader).toBe(SIG_HEADER);
  });

  it("verifies the gold vector (PING body, hex pubkey + hex sig)", async () => {
    expect(await getAdapterForScheme("discord")!.verify(input())).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "discord",
    });
  });

  it("rejects a tampered body as SIGNATURE_MISMATCH", async () => {
    const result = await getAdapterForScheme("discord")!.verify(
      input({ rawBody: utf8Encoder.encode('{"type":2}') }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects a different (wrong) public key as SIGNATURE_MISMATCH", async () => {
    const result = await getAdapterForScheme("discord")!.verify(
      input({ secrets: ["0000000000000000000000000000000000000000000000000000000000000001"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("reports MISSING_HEADER when the timestamp header is absent", async () => {
    const result = await getAdapterForScheme("discord")!.verify(
      input({ headers: [[SIG_HEADER, SIG_HEX]] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });

  it("reports MALFORMED_SIGNATURE for a non-64-byte signature", async () => {
    const result = await getAdapterForScheme("discord")!.verify(
      input({
        headers: [
          [SIG_HEADER, "abcd"],
          [TS_HEADER, TS],
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MALFORMED_SIGNATURE");
  });
});
