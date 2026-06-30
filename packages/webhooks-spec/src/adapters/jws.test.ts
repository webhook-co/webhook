import { describe, expect, it } from "vitest";

import { enforceJwtWindow, parseCompactJws, verifyCompactHs } from "./jws";

// A0b — the compact-JWS primitive shared by the HS256 JWT providers (MessageBird-JWT, Netlify, Vonage,
// Monday, Jira-Connect). It only does the JOSE mechanics: structural parse, alg gate (reject none /
// asymmetric), and constant-time HS256 verification of the signing input against utf8 secret candidates.
// Per-provider claim binding (payload_hash, iss, exp, qsh) lives in each adapter, not here.
//
// Anchored on a REPRODUCED gold vector from MessageBird's Go SDK (signature_jwt/testdata/reference.json),
// re-derived with openssl by the build's research pass: secret + url + body → this exact token.

// PUBLIC test vector from MessageBird's open-source SDK testdata — not a live credential. gitleaks:allow
const MB_SECRET = "36efdd1aace2e26cd490f0d951138253bef2f7c6d34d18981da781555cc4cebb"; // gitleaks:allow
const MB_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJNZXNzYWdlQmlyZCIsIm5iZiI6MTYyNTQ3OTIwMCwiZXhwIjoxNjI1NDc5MjYwLCJqdGkiOiI5M2U1NTAwNi1hMGU4LTQ1MjYtYTE5MC1mYTVmZjAwZWExMTYiLCJ1cmxfaGFzaCI6IjQxZjA1ZjBkZGQwYTIyYWIyMDlhYzQ2ZjQ3YzQ1NzJkOWNlZmEyNTdlZDc0YjI0MDA0YmFlNzUzZWNlNmMyNjAiLCJwYXlsb2FkX2hhc2giOiJkZmZkNjAyMWJiMmJkNWIwYWY2NzYyOTA4MDllYzNhNTMxOTFkZDgxYzdmNzBhNGIyODY4OGEzNjIxODI5ODZmIn0._H--TOuYFLpeEH39-rg5E3IHVkjHozBcaKVWPRC5m9I"; // gitleaks:allow

describe("parseCompactJws", () => {
  it("parses a well-formed compact JWS into header / payload / signing input / signature", () => {
    const parsed = parseCompactJws(MB_TOKEN);
    expect(parsed).not.toBeNull();
    expect(parsed!.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(parsed!.payload.iss).toBe("MessageBird");
    // payload_hash is the real SHA256("Hello, World!") — an independent check the decode is byte-exact.
    expect(parsed!.payload.payload_hash).toBe(
      "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f",
    );
    // signing input is the verbatim ASCII of the first two segments.
    const expectedSigningInput = MB_TOKEN.slice(0, MB_TOKEN.lastIndexOf("."));
    expect(new TextDecoder().decode(parsed!.signingInput)).toBe(expectedSigningInput);
    expect(parsed!.signature.length).toBe(32); // HS256 MAC = 32 bytes
  });

  it("returns null for non-three-segment input (JWE / garbage / empty), never throwing", () => {
    expect(parseCompactJws("a.b")).toBeNull();
    expect(parseCompactJws("a.b.c.d.e")).toBeNull();
    expect(parseCompactJws("")).toBeNull();
    expect(parseCompactJws("....")).toBeNull();
    expect(parseCompactJws("not-base64url!.x.y")).toBeNull();
  });

  it("returns null when a segment is not base64url JSON object", () => {
    // header is base64url("hello") — valid base64url but not a JSON object.
    expect(parseCompactJws("aGVsbG8.aGVsbG8.c2ln")).toBeNull();
  });
});

describe("verifyCompactHs", () => {
  it("verifies the MessageBird gold token against its signing key (verbatim utf8)", async () => {
    const out = await verifyCompactHs(MB_TOKEN, [MB_SECRET]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.secretIndex).toBe(0);
      expect(out.payload.iss).toBe("MessageBird");
      expect(out.payload.url_hash).toBe(
        "41f05f0ddd0a22ab209ac46f47c4572d9cefa257ed74b24004bae753ece6c260",
      );
    }
  });

  it("picks the matching key out of a rotation set (newest-first), reporting its index", async () => {
    const out = await verifyCompactHs(MB_TOKEN, ["a-stale-secret", MB_SECRET]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.secretIndex).toBe(1);
  });

  it("rejects a wrong secret with signature_mismatch", async () => {
    const out = await verifyCompactHs(MB_TOKEN, ["the-wrong-secret"]);
    expect(out).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects no usable key with no_key", async () => {
    const out = await verifyCompactHs(MB_TOKEN, [""]);
    expect(out).toEqual({ ok: false, reason: "no_key" });
  });

  it("rejects alg=none (and any non-allowed alg) as unsupported_alg — never skips the check", async () => {
    // alg:"none" with a forged non-empty signature — the classic JWS downgrade attack; it parses, so
    // the alg gate (not the structural parse) is what must reject it.
    const b64u = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const none = `${b64u({ alg: "none", typ: "JWT" })}.${b64u({ iss: "MessageBird" })}.QUJD`;
    expect(await verifyCompactHs(none, [MB_SECRET])).toEqual({
      ok: false,
      reason: "unsupported_alg",
    });
    // An asymmetric alg the HS verifier can't honor is likewise unsupported (not silently accepted).
    const rs = `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u({ iss: "x" })}.QUJD`;
    expect(await verifyCompactHs(rs, [MB_SECRET])).toEqual({
      ok: false,
      reason: "unsupported_alg",
    });
  });

  it("rejects malformed (non-JWS) input with malformed", async () => {
    const out = await verifyCompactHs("not-a-jws", [MB_SECRET]);
    expect(out).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("enforceJwtWindow", () => {
  const NOW = new Date(1790000000 * 1000); // 1790000000 unix seconds

  it("enforces a max-age ceiling from iat when exp is absent (no unbounded window) — F2 fix", () => {
    const old = enforceJwtWindow({ iat: 1790000000 - 1000 }, 300, NOW); // 1000s old, no exp
    expect(old?.ok).toBe(false);
    if (old && !old.ok) expect(old.reason.code).toBe("TIMESTAMP_TOO_OLD");
    expect(enforceJwtWindow({ iat: 1790000000 - 10 }, 300, NOW)).toBeNull(); // fresh iat-only → ok
  });

  it("prefers exp as the upper bound when present (an old iat with a valid exp passes)", () => {
    expect(enforceJwtWindow({ iat: 1790000000 - 1000, exp: 1790000000 + 60 }, 300, NOW)).toBeNull();
  });

  it("rejects a not-yet-valid token (nbf in the future) as TIMESTAMP_IN_FUTURE", () => {
    const future = enforceJwtWindow({ nbf: 1790000000 + 1000 }, 300, NOW);
    expect(future?.ok).toBe(false);
    if (future && !future.ok) expect(future.reason.code).toBe("TIMESTAMP_IN_FUTURE");
  });

  it("does not age-check a token carrying no temporal claims", () => {
    expect(enforceJwtWindow({ foo: "bar" }, 300, NOW)).toBeNull();
  });

  it("falls back to real time on an Invalid-Date now (a NaN clock can't disable the window)", () => {
    // exp far in the past + Invalid Date → must still reject (uses Date.now(), which is ~2026 >> exp).
    const out = enforceJwtWindow({ exp: 1625479260 }, 300, new Date(NaN));
    expect(out?.ok).toBe(false);
    if (out && !out.ok) expect(out.reason.code).toBe("TIMESTAMP_TOO_OLD");
  });
});
