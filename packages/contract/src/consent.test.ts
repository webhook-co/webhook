import { describe, expect, it } from "vitest";

import { ConsentDecisionSchema, ConsentRequestSchema } from "./consent";

// The C↔E consent contract (A3). ConsentRequest is what Lane C SSRs (validated here as documentation of
// the shape, incl. BOTH durations); ConsentDecision is the untrusted POST body Lane C's /authorize handler
// validates.

const VALID_REQUEST = {
  requestId: "areq_1",
  csrfToken: "csrf_1",
  flow: "pkce_loopback",
  client: { id: "cli_wbhk", name: "webhook CLI" },
  org: { id: "org_1", name: "Personal" },
  origin: { ip: "203.0.113.7", location: null },
  scopes: ["events:read"],
  audience: "https://api.webhook.co",
  grantExpiresAt: "2026-09-18T00:00:00Z",
  keyTtlSeconds: 86_400,
};

describe("ConsentRequestSchema", () => {
  it("accepts a valid request carrying both durations (grantExpiresAt + keyTtlSeconds)", () => {
    const parsed = ConsentRequestSchema.parse(VALID_REQUEST);
    expect(parsed.grantExpiresAt).toBe("2026-09-18T00:00:00Z");
    expect(parsed.keyTtlSeconds).toBe(86_400);
  });

  it("requires both durations + a positive integer key TTL", () => {
    const { grantExpiresAt: _g, ...noGrant } = VALID_REQUEST;
    expect(ConsentRequestSchema.safeParse(noGrant).success).toBe(false);
    const { keyTtlSeconds: _k, ...noKey } = VALID_REQUEST;
    expect(ConsentRequestSchema.safeParse(noKey).success).toBe(false);
    expect(ConsentRequestSchema.safeParse({ ...VALID_REQUEST, keyTtlSeconds: -1 }).success).toBe(
      false,
    );
    expect(ConsentRequestSchema.safeParse({ ...VALID_REQUEST, keyTtlSeconds: 1.5 }).success).toBe(
      false,
    );
  });

  it("the optional device is allowed (device-code flow)", () => {
    expect(
      ConsentRequestSchema.safeParse({ ...VALID_REQUEST, device: { name: "laptop" } }).success,
    ).toBe(true);
  });
});

describe("ConsentDecisionSchema", () => {
  it("accepts approve/deny with a non-empty requestId + csrfToken", () => {
    expect(
      ConsentDecisionSchema.parse({ requestId: "a", csrfToken: "c", decision: "approve" }).decision,
    ).toBe("approve");
    expect(
      ConsentDecisionSchema.safeParse({ requestId: "a", csrfToken: "c", decision: "deny" }).success,
    ).toBe(true);
  });

  it("rejects an unknown decision, or an empty requestId/csrfToken", () => {
    expect(
      ConsentDecisionSchema.safeParse({ requestId: "a", csrfToken: "c", decision: "maybe" })
        .success,
    ).toBe(false);
    expect(
      ConsentDecisionSchema.safeParse({ requestId: "", csrfToken: "c", decision: "approve" })
        .success,
    ).toBe(false);
    expect(
      ConsentDecisionSchema.safeParse({ requestId: "a", csrfToken: "", decision: "approve" })
        .success,
    ).toBe(false);
  });
});
