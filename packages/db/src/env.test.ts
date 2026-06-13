import { describe, expect, it } from "vitest";

import { CREDENTIAL_PEPPER_MIN_BYTES } from "./credential";
import { resolveCredentialHasher, resolveDatabaseUrl } from "./env";

const PEPPER_B64 = Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x7a).toString("base64");
const PEPPER2_B64 = Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0x5b).toString("base64");

describe("resolveDatabaseUrl", () => {
  it("returns DATABASE_URL when set", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://x/y" })).toBe("postgres://x/y");
  });

  it("throws a helpful error when unset", () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/DATABASE_URL is not set/);
  });

  it("treats a blank value as unset", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "   " })).toThrow(/DATABASE_URL is not set/);
  });
});

describe("resolveCredentialHasher", () => {
  it("builds a hasher from CREDENTIAL_PEPPER (base64)", () => {
    const hasher = resolveCredentialHasher({ CREDENTIAL_PEPPER: PEPPER_B64 });
    // Produces a 32-byte HMAC digest and exactly one candidate (no previous pepper).
    expect(hasher.hash("whk_x").length).toBe(32);
    expect(hasher.candidates("whk_x").length).toBe(1);
  });

  it("REQUIRES the pepper — throws loud when unset (no insecure default)", () => {
    expect(() => resolveCredentialHasher({})).toThrow(/CREDENTIAL_PEPPER is not set/);
  });

  it("rejects a pepper that decodes to fewer than 32 bytes", () => {
    const tooShort = Buffer.alloc(16, 1).toString("base64");
    expect(() => resolveCredentialHasher({ CREDENTIAL_PEPPER: tooShort })).toThrow(
      /pepper must be >= 32 bytes/,
    );
  });

  it("accepts a comma-separated CREDENTIAL_PEPPER_PREVIOUS for rotation", () => {
    const hasher = resolveCredentialHasher({
      CREDENTIAL_PEPPER: PEPPER_B64,
      CREDENTIAL_PEPPER_PREVIOUS: PEPPER2_B64,
    });
    expect(hasher.candidates("whk_x").length).toBe(2);
  });

  it("ignores blank entries in CREDENTIAL_PEPPER_PREVIOUS", () => {
    const hasher = resolveCredentialHasher({
      CREDENTIAL_PEPPER: PEPPER_B64,
      CREDENTIAL_PEPPER_PREVIOUS: `${PEPPER2_B64}, , `,
    });
    expect(hasher.candidates("whk_x").length).toBe(2);
  });
});
