import { describe, expect, it } from "vitest";

import { deriveChallenge, generatePkce, randomBase64url, randomState } from "./pkce.js";

describe("PKCE (RFC 7636, S256)", () => {
  it("deriveChallenge matches the RFC 7636 Appendix B test vector", async () => {
    // The canonical example from RFC 7636 §B: verifier → base64url(SHA-256(verifier)).
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    await expect(deriveChallenge(verifier)).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("generatePkce produces a verifier whose challenge derives from it (base64url, no padding)", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(verifier.length).toBeGreaterThanOrEqual(43); // RFC 7636 minimum
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(deriveChallenge(verifier)).resolves.toBe(challenge);
  });

  it("generates a distinct verifier each time", async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });

  it("randomState / randomBase64url are url-safe and non-empty", () => {
    expect(randomState()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomBase64url(16)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomState()).not.toBe(randomState());
  });
});
