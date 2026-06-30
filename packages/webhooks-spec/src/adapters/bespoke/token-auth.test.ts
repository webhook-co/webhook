import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// Tier-4 NON-CRYPTOGRAPHIC authenticity (S2.2 A5). These providers prove the source by a shared static
// token / HTTP Basic credential, NOT a signature over the payload — a match is the weaker "authenticated"
// status (authenticity "token"/"basic"). The factory covers four sources: fixed header (GitLab), a body
// JSON field (Microsoft Graph clientState), HTTP Basic (Chargebee/Postmark/SparkPost), and an
// operator-configured header whose name lives in the secret (Okta/BigCommerce/Datadog/Brevo).
//
// All test tokens/credentials below are fabricated for the unit test — not live secrets.

function basicHeader(userPass: string): string {
  // Build `Basic b64(user:pass)` for the Authorization header.
  return `Basic ${btoa(userPass)}`; // gitleaks:allow — synthetic test credential
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode("{}"),
    headers: [] as [string, string][],
    secrets: [] as string[],
    method: "POST",
    requestUrl: "https://example.com/ingest",
    ...overrides,
  };
}

describe("token-auth Tier-4 registry wiring", () => {
  const expected: Array<[string, string]> = [
    ["gitlab", "x-gitlab-token"],
    ["microsoft_graph", ""],
    ["chargebee", "authorization"],
    ["postmark", "authorization"],
    ["sparkpost", "authorization"],
    ["okta", ""],
    ["bigcommerce", ""],
    ["datadog", ""],
    ["brevo", ""],
  ];
  it.each(expected)("registers %s with signatureHeader %j", (slug, header) => {
    const adapter = getAdapterForScheme(slug as Parameters<typeof getAdapterForScheme>[0]);
    expect(adapter).toBeDefined();
    expect(adapter!.scheme).toBe(slug);
    expect(adapter!.signatureHeader).toBe(header);
  });
});

describe("gitlab — fixed-header token equality", () => {
  const adapter = getAdapterForScheme("gitlab")!;
  const TOKEN = "gl-secret-token-abc123";

  it("authenticates a matching X-Gitlab-Token as token (non-crypto)", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-gitlab-token", TOKEN]], secrets: [TOKEN] }),
    );
    expect(result).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "gitlab",
      authenticity: "token",
    });
  });

  it("rejects a wrong token with SIGNATURE_MISMATCH", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-gitlab-token", "wrong"]], secrets: [TOKEN] }),
    );
    expect(result).toEqual({ ok: false, reason: { code: "SIGNATURE_MISMATCH" } });
  });

  it("reports MISSING_HEADER when the header is absent", async () => {
    const result = await adapter.verify(input({ headers: [], secrets: [TOKEN] }));
    expect(result).toEqual({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "x-gitlab-token", scheme: "gitlab" },
    });
  });

  it("reports NO_MATCHING_KEY when no secret is registered", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-gitlab-token", TOKEN]], secrets: [] }),
    );
    expect(result).toEqual({ ok: false, reason: { code: "NO_MATCHING_KEY", keysTried: 0 } });
  });

  it("matches a rotated second secret (keyId secret_1)", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-gitlab-token", TOKEN]], secrets: ["old-token", TOKEN] }),
    );
    expect(result).toMatchObject({ ok: true, keyId: "secret_1", authenticity: "token" });
  });
});

describe("microsoft_graph — body clientState equality", () => {
  const adapter = getAdapterForScheme("microsoft_graph")!;
  const STATE = "graph-subscription-state-xyz";
  const body = (state: unknown) =>
    utf8Encoder.encode(JSON.stringify({ value: [{ clientState: state }] }));

  it("authenticates a matching value[0].clientState as token", async () => {
    const result = await adapter.verify(input({ rawBody: body(STATE), secrets: [STATE] }));
    expect(result).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "microsoft_graph",
      authenticity: "token",
    });
  });

  it("rejects a mismatched clientState with SIGNATURE_MISMATCH", async () => {
    const result = await adapter.verify(input({ rawBody: body("nope"), secrets: [STATE] }));
    expect(result).toEqual({ ok: false, reason: { code: "SIGNATURE_MISMATCH" } });
  });

  it("reports MALFORMED_SIGNATURE when the field is absent", async () => {
    const result = await adapter.verify(
      input({ rawBody: utf8Encoder.encode(JSON.stringify({ value: [{}] })), secrets: [STATE] }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: { code: "MALFORMED_SIGNATURE", scheme: "microsoft_graph" },
    });
  });

  it("reports MALFORMED_SIGNATURE when the body is not JSON", async () => {
    const result = await adapter.verify(
      input({ rawBody: utf8Encoder.encode("not json"), secrets: [STATE] }),
    );
    expect(result).toMatchObject({ ok: false, reason: { code: "MALFORMED_SIGNATURE" } });
  });
});

describe("chargebee — HTTP Basic auth", () => {
  const adapter = getAdapterForScheme("chargebee")!;
  const CRED = "wh_user:wh_pass_9z"; // gitleaks:allow — synthetic test credential

  it("authenticates correct Basic credentials as basic (non-crypto)", async () => {
    const result = await adapter.verify(
      input({ headers: [["authorization", basicHeader(CRED)]], secrets: [CRED] }),
    );
    expect(result).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "chargebee",
      authenticity: "basic",
    });
  });

  it("rejects wrong Basic credentials with SIGNATURE_MISMATCH", async () => {
    const result = await adapter.verify(
      input({ headers: [["authorization", basicHeader("wh_user:wrong")]], secrets: [CRED] }),
    );
    expect(result).toEqual({ ok: false, reason: { code: "SIGNATURE_MISMATCH" } });
  });

  it("reports MISSING_HEADER when Authorization is absent", async () => {
    const result = await adapter.verify(input({ headers: [], secrets: [CRED] }));
    expect(result).toMatchObject({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "authorization" },
    });
  });

  it("reports MISSING_HEADER when Authorization is not Basic", async () => {
    const result = await adapter.verify(
      input({ headers: [["authorization", "Bearer abc"]], secrets: [CRED] }),
    );
    expect(result).toMatchObject({
      ok: false,
      reason: { code: "MISSING_HEADER", header: "authorization" },
    });
  });
});

describe("okta — operator-configured header (secret carries the header name)", () => {
  const adapter = getAdapterForScheme("okta")!;
  const SECRET = JSON.stringify({ header: "x-okta-secret", token: "okta-shared-secret-42" });

  it("authenticates a matching configured header as token", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-okta-secret", "okta-shared-secret-42"]], secrets: [SECRET] }),
    );
    expect(result).toEqual({
      ok: true,
      keyId: "secret_0",
      scheme: "okta",
      authenticity: "token",
    });
  });

  it("rejects a wrong configured-header value with SIGNATURE_MISMATCH", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-okta-secret", "wrong"]], secrets: [SECRET] }),
    );
    expect(result).toEqual({ ok: false, reason: { code: "SIGNATURE_MISMATCH" } });
  });

  it("rejects when the configured header is absent (usable secret, no match)", async () => {
    const result = await adapter.verify(input({ headers: [], secrets: [SECRET] }));
    expect(result).toEqual({ ok: false, reason: { code: "SIGNATURE_MISMATCH" } });
  });

  it("reports NO_MATCHING_KEY when no secret is a valid {header,token} JSON", async () => {
    const result = await adapter.verify(
      input({ headers: [["x-okta-secret", "okta-shared-secret-42"]], secrets: ["not-json"] }),
    );
    expect(result).toEqual({ ok: false, reason: { code: "NO_MATCHING_KEY", keysTried: 0 } });
  });

  it("treats an EMPTY configured token as unusable — no open match on an empty header value", async () => {
    // An operator misconfiguration {header, token:""} must NOT let an attacker forge an authenticated
    // event by sending an empty header value (tokenEqual("","") would otherwise be true). The empty-token
    // secret is unusable, exactly like an empty secret on the fixed-location path.
    const emptyToken = JSON.stringify({ header: "x-okta-secret", token: "" });
    const result = await adapter.verify(
      input({ headers: [["x-okta-secret", ""]], secrets: [emptyToken] }),
    );
    expect(result).toEqual({ ok: false, reason: { code: "NO_MATCHING_KEY", keysTried: 0 } });
  });

  it("treats an EMPTY configured header name as unusable (NO_MATCHING_KEY)", async () => {
    const emptyHeader = JSON.stringify({ header: "", token: "okta-shared-secret-42" });
    const result = await adapter.verify(
      input({ headers: [["", "okta-shared-secret-42"]], secrets: [emptyHeader] }),
    );
    expect(result).toEqual({ ok: false, reason: { code: "NO_MATCHING_KEY", keysTried: 0 } });
  });
});
