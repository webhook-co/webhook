import { describe, expect, it } from "vitest";

import {
  parseVerifyTokenSecret,
  serializeVerifyTokenSecret,
  VERIFY_TOKEN_PROVIDERS,
  verifyTokenEqual,
} from "./verify-token";

// The GET-handshake verify-token secret shape (S8 Slice 2 PR2b). A user-chosen compare-token (Meta
// `hub.verify_token`) is sealed as a TYPED blob `{kind:"verify_token",token}` so it is distinguishable, at
// unseal, from a bare HMAC app-secret stored under the SAME provider slug (`meta`). The db SERIALIZES it
// before sealing; the engine PARSES it after unsealing — both single-sourced here.

describe("verify-token secret blob", () => {
  it("round-trips: serialize → parse returns the original token", () => {
    const token = "my-meta-verify-token-123";
    expect(parseVerifyTokenSecret(serializeVerifyTokenSecret(token))).toBe(token);
  });

  it("serializes to the typed JSON blob with a `verify_token` kind tag", () => {
    expect(JSON.parse(serializeVerifyTokenSecret("abc"))).toEqual({
      kind: "verify_token",
      token: "abc",
    });
  });

  it("preserves a token with whitespace / unicode exactly (no trim, byte-faithful)", () => {
    const token = "  spaced 𝕥oken  ";
    expect(parseVerifyTokenSecret(serializeVerifyTokenSecret(token))).toBe(token);
  });

  it("parse returns null for a BARE HMAC secret (not a verify-token blob — the app-secret coexists)", () => {
    expect(parseVerifyTokenSecret("whsec_rawAppSecretBytes")).toBeNull();
    expect(parseVerifyTokenSecret("just-a-plain-string")).toBeNull();
  });

  it("parse returns null for malformed JSON and for the wrong kind / shape", () => {
    expect(parseVerifyTokenSecret("{not json")).toBeNull();
    expect(
      parseVerifyTokenSecret(JSON.stringify({ kind: "signing_secret", token: "x" })),
    ).toBeNull();
    expect(parseVerifyTokenSecret(JSON.stringify({ kind: "verify_token" }))).toBeNull(); // no token
    expect(parseVerifyTokenSecret(JSON.stringify({ kind: "verify_token", token: "" }))).toBeNull(); // empty
    expect(parseVerifyTokenSecret(JSON.stringify({ kind: "verify_token", token: 42 }))).toBeNull(); // non-string
    expect(parseVerifyTokenSecret(JSON.stringify(["verify_token", "x"]))).toBeNull(); // array, not object
  });
});

describe("verifyTokenEqual (constant-time)", () => {
  it("true only for a byte-exact match", () => {
    expect(verifyTokenEqual("token-abc", "token-abc")).toBe(true);
    expect(verifyTokenEqual("token-abc", "token-abd")).toBe(false);
    expect(verifyTokenEqual("token-abc", "token-ab")).toBe(false); // length differs
    expect(verifyTokenEqual("token-abc", "TOKEN-ABC")).toBe(false); // case-sensitive
    expect(verifyTokenEqual("", "")).toBe(true);
  });
});

describe("VERIFY_TOKEN_PROVIDERS", () => {
  it("includes meta and excludes a non-handshake provider", () => {
    expect(VERIFY_TOKEN_PROVIDERS.has("meta")).toBe(true);
    expect(VERIFY_TOKEN_PROVIDERS.has("stripe")).toBe(false);
  });
});
