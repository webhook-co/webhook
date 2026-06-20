import { describe, expect, it } from "vitest";

import { readAuthEnv } from "./env";

// A1b-1 — fail-closed env validation. The Worker's bindings/secrets are untyped at the boundary
// (getCloudflareContext returns a loose record), so we validate rather than blind-cast: a missing secret
// or a mis-named Hyperdrive binding must throw a clear error on the first request, never sign sessions
// with an empty secret or read `undefined.connectionString`.

const RAW = {
  HYPERDRIVE_AUTH: { connectionString: "postgres://auth@hd/db" },
  HYPERDRIVE_TENANT: { connectionString: "postgres://app@hd/db" },
  BETTER_AUTH_SECRET: "secret",
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsec",
  GITHUB_CLIENT_ID: "hid",
  GITHUB_CLIENT_SECRET: "hsec",
  RESEND_API_KEY: "re_key",
};

describe("readAuthEnv", () => {
  it("returns the env when every secret + binding is present", () => {
    expect(readAuthEnv({ ...RAW })).toMatchObject({ BETTER_AUTH_SECRET: "secret" });
  });

  it("throws when a required secret is missing", () => {
    const { BETTER_AUTH_SECRET: _omit, ...partial } = RAW;
    expect(() => readAuthEnv(partial)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when a required secret is present but empty (no empty-secret session signing)", () => {
    expect(() => readAuthEnv({ ...RAW, BETTER_AUTH_SECRET: "" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when a Hyperdrive binding is missing or malformed (catches a mis-named binding)", () => {
    const { HYPERDRIVE_AUTH: _omit, ...partial } = RAW;
    expect(() => readAuthEnv(partial)).toThrow(/HYPERDRIVE_AUTH/);
    expect(() => readAuthEnv({ ...RAW, HYPERDRIVE_AUTH: {} })).toThrow(/HYPERDRIVE_AUTH/);
  });

  it("never includes a secret VALUE in the error message", () => {
    try {
      readAuthEnv({ ...RAW, RESEND_API_KEY: "" });
    } catch (e) {
      expect(String(e)).toContain("RESEND_API_KEY");
      expect(String(e)).not.toContain("re_key");
    }
  });
});
