import { describe, expect, it, vi } from "vitest";

import { readAuthEnv, readIntrospectEnv, resolveAuthSecrets, type AuthEnv } from "./env";

// A1b — fail-closed env validation + secret resolution. The Worker's bindings/secrets are untyped at the
// boundary (getCloudflareContext returns a loose record), so we validate rather than blind-cast: a missing
// secret or a mis-named Hyperdrive binding must throw a clear error on the first request. Secrets are
// Cloudflare Secrets Store bindings in prod (an object with `.get()`) and plain strings in dev/test;
// resolveAuthSecrets reads both into plain strings.

const RAW = {
  HYPERDRIVE_AUTH: { connectionString: "postgres://auth@hd/db" },
  HYPERDRIVE_TENANT: { connectionString: "postgres://app@hd/db" },
  BETTER_AUTH_SECRET: "secret",
  CREDENTIAL_PEPPER: "cGVwcGVy",
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

  it("accepts a Secrets Store-shaped secret (an object with .get) as well as a plain string", () => {
    const storeSecret = { get: async () => "from-store" };
    expect(() => readAuthEnv({ ...RAW, RESEND_API_KEY: storeSecret })).not.toThrow();
  });

  it("throws when a required secret is missing", () => {
    const { BETTER_AUTH_SECRET: _omit, ...partial } = RAW;
    expect(() => readAuthEnv(partial)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("throws when CREDENTIAL_PEPPER (the bootstrap hasher key) is missing", () => {
    const { CREDENTIAL_PEPPER: _omit, ...partial } = RAW;
    expect(() => readAuthEnv(partial)).toThrow(/CREDENTIAL_PEPPER/);
  });

  it("throws when a required secret is present but an empty string", () => {
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

describe("readIntrospectEnv", () => {
  it("returns the env when OAUTH_KV is bound", () => {
    expect(readIntrospectEnv({ OAUTH_KV: {} })).toMatchObject({ OAUTH_KV: {} });
  });

  it("throws (fail-closed) when OAUTH_KV is absent or not an object", () => {
    expect(() => readIntrospectEnv({})).toThrow(/OAUTH_KV/);
    expect(() => readIntrospectEnv({ OAUTH_KV: "nope" })).toThrow(/OAUTH_KV/);
  });
});

describe("resolveAuthSecrets", () => {
  it("passes plain-string secrets through", async () => {
    const resolved = await resolveAuthSecrets(readAuthEnv({ ...RAW }));
    expect(resolved).toEqual({
      betterAuthSecret: "secret",
      credentialPepper: "cGVwcGVy",
      googleClientId: "gid",
      googleClientSecret: "gsec",
      githubClientId: "hid",
      githubClientSecret: "hsec",
      resendApiKey: "re_key",
    });
  });

  it("reads a Secrets Store binding via .get()", async () => {
    const get = vi.fn(async () => "resolved-from-store");
    const env = readAuthEnv({ ...RAW, BETTER_AUTH_SECRET: { get } }) as AuthEnv;
    const resolved = await resolveAuthSecrets(env);
    expect(get).toHaveBeenCalledTimes(1);
    expect(resolved.betterAuthSecret).toBe("resolved-from-store");
  });

  it("fails closed when a store binding resolves to an EMPTY value (readAuthEnv can't see inside it)", async () => {
    const env = readAuthEnv({ ...RAW, BETTER_AUTH_SECRET: { get: async () => "" } }) as AuthEnv;
    await expect(resolveAuthSecrets(env)).rejects.toThrow(/betterAuthSecret/);
  });
});
