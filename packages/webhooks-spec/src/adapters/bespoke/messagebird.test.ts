import { describe, expect, it } from "vitest";

import { utf8Encoder } from "../../bytes";
import { getAdapterForScheme } from "../registry";

// MessageBird-JWT (current classic scheme) — a bespoke JWS adapter on the A0b jws primitive. The header
// `MessageBird-Signature-JWT` carries an HS256 JWT whose claims authenticate the request and bind the
// body + URL via `payload_hash` / `url_hash` (lowercase-hex SHA-256). We verify the HS256 signature
// (key = the dashboard "Signing key" verbatim utf8), enforce iss + nbf/exp, then INDEPENDENTLY recompute
// SHA-256(body) and SHA-256(url) and compare.
//
// Anchored on the REPRODUCED gold vector from MessageBird's Go SDK (signature_jwt/testdata/reference.json).

// PUBLIC test vector from MessageBird's open-source SDK testdata — not a live credential. gitleaks:allow
const MB_SECRET = "36efdd1aace2e26cd490f0d951138253bef2f7c6d34d18981da781555cc4cebb"; // gitleaks:allow
const MB_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJNZXNzYWdlQmlyZCIsIm5iZiI6MTYyNTQ3OTIwMCwiZXhwIjoxNjI1NDc5MjYwLCJqdGkiOiI5M2U1NTAwNi1hMGU4LTQ1MjYtYTE5MC1mYTVmZjAwZWExMTYiLCJ1cmxfaGFzaCI6IjQxZjA1ZjBkZGQwYTIyYWIyMDlhYzQ2ZjQ3YzQ1NzJkOWNlZmEyNTdlZDc0YjI0MDA0YmFlNzUzZWNlNmMyNjAiLCJwYXlsb2FkX2hhc2giOiJkZmZkNjAyMWJiMmJkNWIwYWY2NzYyOTA4MDllYzNhNTMxOTFkZDgxYzdmNzBhNGIyODY4OGEzNjIxODI5ODZmIn0._H--TOuYFLpeEH39-rg5E3IHVkjHozBcaKVWPRC5m9I"; // gitleaks:allow
const MB_URL = "https://example.com/path?bar=1&foo=2";
const MB_BODY = "Hello, World!";
const HEADER = "messagebird-signature-jwt";
// nbf=1625479200, exp=1625479260 → inject a `now` inside the window.
const NOW_IN_WINDOW = new Date(1625479230 * 1000);

function base(overrides: Record<string, unknown> = {}) {
  return {
    rawBody: utf8Encoder.encode(MB_BODY),
    headers: [[HEADER, MB_TOKEN]] as [string, string][],
    secrets: [MB_SECRET],
    requestUrl: MB_URL,
    method: "POST",
    now: NOW_IN_WINDOW,
    ...overrides,
  };
}

describe("messagebird-JWT bespoke (HS256 JWT + payload_hash/url_hash binding)", () => {
  it("exposes messagebird metadata", () => {
    const adapter = getAdapterForScheme("messagebird")!;
    expect(adapter.scheme).toBe("messagebird");
    expect(adapter.signatureHeader).toBe(HEADER);
  });

  it("verifies the gold token (signature + iss + window + body/url hash all match)", async () => {
    const result = await getAdapterForScheme("messagebird")!.verify(base());
    expect(result).toEqual({ ok: true, keyId: "secret_0", scheme: "messagebird" });
  });

  it("rejects a wrong signing key with WRONG_SECRET", async () => {
    const result = await getAdapterForScheme("messagebird")!.verify(base({ secrets: ["nope"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("WRONG_SECRET");
  });

  it("rejects a mutated body (signature valid, payload_hash no longer matches) as PROXY_MUTATED_BYTES", async () => {
    const result = await getAdapterForScheme("messagebird")!.verify(
      base({ rawBody: utf8Encoder.encode("Hello, World?") }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("PROXY_MUTATED_BYTES");
  });

  it("rejects a url that doesn't match url_hash as SIGNATURE_MISMATCH", async () => {
    const result = await getAdapterForScheme("messagebird")!.verify(
      base({ requestUrl: "https://example.com/path?bar=9&foo=2" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects an expired token (now past exp + tolerance) as TIMESTAMP_TOO_OLD", async () => {
    const result = await getAdapterForScheme("messagebird")!.verify(
      base({ now: new Date(1700000000 * 1000) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });

  it("reports MISSING_HEADER when the JWT header is absent", async () => {
    const result = await getAdapterForScheme("messagebird")!.verify(base({ headers: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.code).toBe("MISSING_HEADER");
  });
});
