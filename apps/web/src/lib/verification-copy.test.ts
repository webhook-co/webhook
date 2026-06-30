import type { VerificationResult } from "@webhook-co/webhooks-spec";
import { describe, expect, it } from "vitest";

import { verificationCopy } from "./verification-copy";

describe("verificationCopy", () => {
  it("null (never attempted) is NEUTRAL, not a failure", () => {
    const c = verificationCopy(null);
    expect(c.tone).toBe("neutral");
    expect(c.pill).toBe("Not verified");
    expect(c.detail).toMatch(/no signing secret was configured/i);
  });

  it("ok → verified, names the scheme + keyId", () => {
    const c = verificationCopy({ ok: true, keyId: "key_1", scheme: "stripe" });
    expect(c.tone).toBe("ok");
    expect(c.pill).toBe("Verified");
    expect(c.detail).toContain("stripe");
    expect(c.detail).toContain("key_1");
  });

  it("ok + authenticity:token → the weaker 'Authenticated' badge, flagged non-cryptographic", () => {
    const c = verificationCopy({
      ok: true,
      keyId: "secret_0",
      scheme: "gitlab",
      authenticity: "token",
    });
    expect(c.tone).toBe("ok");
    expect(c.pill).toBe("Authenticated");
    expect(c.detail).toMatch(/non-cryptographic/i);
    expect(c.detail).toContain("gitlab");
  });

  it("ok + authenticity:basic → 'Authenticated' naming HTTP Basic, non-cryptographic", () => {
    const c = verificationCopy({
      ok: true,
      keyId: "secret_0",
      scheme: "chargebee",
      authenticity: "basic",
    });
    expect(c.pill).toBe("Authenticated");
    expect(c.detail).toMatch(/basic/i);
    expect(c.detail).toMatch(/non-cryptographic/i);
  });

  const failures: ReadonlyArray<[string, VerificationResult, RegExp]> = [
    [
      "MISSING_HEADER",
      {
        ok: false,
        reason: {
          code: "MISSING_HEADER",
          header: "Webhook-Signature",
          scheme: "standard_webhooks",
        },
      },
      /header Webhook-Signature was missing/i,
    ],
    [
      "MALFORMED_SIGNATURE",
      {
        ok: false,
        reason: { code: "MALFORMED_SIGNATURE", detail: "no v1 part", scheme: "stripe" },
      },
      /malformed: no v1 part/i,
    ],
    [
      "UNSUPPORTED_SCHEME (with headers)",
      { ok: false, reason: { code: "UNSUPPORTED_SCHEME", observedHeaders: ["X-Foo", "X-Bar"] } },
      /X-Foo, X-Bar/,
    ],
    [
      "UNSUPPORTED_SCHEME (no headers)",
      { ok: false, reason: { code: "UNSUPPORTED_SCHEME", observedHeaders: [] } },
      /no signature headers were present/i,
    ],
    [
      "TIMESTAMP_TOO_OLD",
      { ok: false, reason: { code: "TIMESTAMP_TOO_OLD", skewSeconds: 400, toleranceSeconds: 300 } },
      /400s old, beyond the 300s tolerance/i,
    ],
    [
      "TIMESTAMP_IN_FUTURE",
      {
        ok: false,
        reason: { code: "TIMESTAMP_IN_FUTURE", skewSeconds: 120, toleranceSeconds: 60 },
      },
      /120s in the future, beyond the 60s tolerance/i,
    ],
    [
      "NO_MATCHING_KEY",
      { ok: false, reason: { code: "NO_MATCHING_KEY", keysTried: 3 } },
      /none of the 3 configured signing key/i,
    ],
    [
      "WRONG_SECRET",
      { ok: false, reason: { code: "WRONG_SECRET", confidence: "medium" } },
      /secret is likely wrong \(medium confidence\)/i,
    ],
    [
      "RAW_BODY_MODIFIED (with evidence)",
      {
        ok: false,
        reason: { code: "RAW_BODY_MODIFIED", confidence: "low", evidence: "trailing_whitespace" },
      },
      /trailing whitespace added.*low confidence/i,
    ],
    [
      "RAW_BODY_MODIFIED (no evidence)",
      { ok: false, reason: { code: "RAW_BODY_MODIFIED", confidence: "medium" } },
      /modified in transit \(medium confidence\)/i,
    ],
    [
      "PROXY_MUTATED_BYTES",
      { ok: false, reason: { code: "PROXY_MUTATED_BYTES", confidence: "low" } },
      /a proxy appears to have altered the raw bytes/i,
    ],
    [
      "SIGNATURE_MISMATCH",
      { ok: false, reason: { code: "SIGNATURE_MISMATCH" } },
      /did not match the payload/i,
    ],
  ];

  it.each(failures)("failure %s → danger + diagnostic copy", (_label, verification, expected) => {
    const c = verificationCopy(verification);
    expect(c.tone).toBe("danger");
    expect(c.pill).toBe("Verification failed");
    expect(c.detail).toMatch(expected);
  });
});
