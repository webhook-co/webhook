import { describe, expect, it } from "vitest";

import { CLOCK_SKEW_TOLERANCE_SECONDS, WEBHOOK_SCHEMES } from "./scheme";
import {
  VerificationResultSchema,
  verificationFailed,
  verificationOk,
  type VerificationResult,
} from "./verification";

describe("verification union", () => {
  it("round-trips a success result through the schema", () => {
    const ok = verificationOk("key_1", "stripe");
    expect(VerificationResultSchema.parse(ok)).toEqual(ok);
  });

  it("round-trips each failure code through the schema", () => {
    const failures: VerificationResult[] = [
      verificationFailed({ code: "MISSING_HEADER", header: "stripe-signature", scheme: "stripe" }),
      verificationFailed({ code: "MALFORMED_SIGNATURE", detail: "no v1=", scheme: "stripe" }),
      verificationFailed({ code: "UNSUPPORTED_SCHEME", observedHeaders: ["x-foo"] }),
      verificationFailed({ code: "TIMESTAMP_TOO_OLD", skewSeconds: 600, toleranceSeconds: 300 }),
      verificationFailed({ code: "TIMESTAMP_IN_FUTURE", skewSeconds: -600, toleranceSeconds: 300 }),
      verificationFailed({ code: "NO_MATCHING_KEY", keysTried: 3 }),
      verificationFailed({ code: "WRONG_SECRET", confidence: "low" }),
      verificationFailed({
        code: "RAW_BODY_MODIFIED",
        confidence: "medium",
        evidence: "reencoded_json",
      }),
      verificationFailed({ code: "PROXY_MUTATED_BYTES", confidence: "low" }),
      verificationFailed({ code: "SIGNATURE_MISMATCH" }),
    ];
    for (const f of failures) {
      expect(VerificationResultSchema.parse(f)).toEqual(f);
    }
  });

  it("rejects an unknown failure code", () => {
    expect(() => VerificationResultSchema.parse({ ok: false, reason: { code: "NOPE" } })).toThrow();
  });

  it("rejects a heuristic failure missing its confidence", () => {
    expect(() =>
      VerificationResultSchema.parse({ ok: false, reason: { code: "WRONG_SECRET" } }),
    ).toThrow();
  });

  it("defines a clock-skew tolerance for every scheme", () => {
    for (const scheme of WEBHOOK_SCHEMES) {
      expect(CLOCK_SKEW_TOLERANCE_SECONDS[scheme]).toBeGreaterThan(0);
    }
  });
});
