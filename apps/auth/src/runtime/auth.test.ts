import { describe, expect, it, vi } from "vitest";

import { buildAuthConfig, magicLinkOptions, makeAuth, resolveBaseUrl } from "./auth";
import type { AuthConfigDeps, AuthConfigInput } from "./auth";
import type { AuthEnv, ResolvedAuthSecrets } from "./env";

// A1b — the Better Auth runtime config. These tests pin the security-relevant wiring (the parts a later
// refactor could silently break): providers sourced from the resolved secrets, a HOST-ONLY cookie (the
// auth.→app. handoff is the backchannel session-exchange, NOT a shared cross-subdomain cookie — founder
// X-2), DB-validated sessions (no cookieCache), single-use HASHED magic-link tokens, and the bootstrap
// hooks wired in. The full Better Auth instance (makeAuth → betterAuth over a pg Pool) is integration-
// validated by build:cf; the smoke test only proves it constructs + exposes a close hook.

const SECRETS: ResolvedAuthSecrets = {
  betterAuthSecret: "test-secret",
  credentialPepper: "cGVwcGVy",
  googleClientId: "google-id",
  googleClientSecret: "google-secret",
  githubClientId: "github-id",
  githubClientSecret: "github-secret",
  resendApiKey: "re_test",
};

const input = (baseURL = "https://auth.webhook.co"): AuthConfigInput => ({
  baseURL,
  secrets: SECRETS,
});

const cfgDeps = (over: Partial<AuthConfigDeps> = {}): AuthConfigDeps => ({
  database: {} as never,
  sendEmail: vi.fn(async () => {}),
  databaseHooks: undefined,
  ...over,
});

const ENV: AuthEnv = {
  HYPERDRIVE_AUTH: { connectionString: "postgres://auth@hd/db" },
  HYPERDRIVE_TENANT: { connectionString: "postgres://app@hd/db" },
  BETTER_AUTH_SECRET: "test-secret",
  CREDENTIAL_PEPPER: "cGVwcGVy",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-id",
  GITHUB_CLIENT_SECRET: "github-secret",
  RESEND_API_KEY: "re_test",
};

describe("magicLinkOptions", () => {
  it("expires in 5 minutes and stores tokens hashed (never plaintext in the DB)", () => {
    const o = magicLinkOptions({ sendEmail: vi.fn(async () => {}) });
    expect(o.expiresIn).toBe(300);
    expect(o.storeToken).toBe("hashed");
  });

  it("sendMagicLink forwards the recipient + URL to the injected email sender", async () => {
    const sendEmail = vi.fn(async () => {});
    await magicLinkOptions({ sendEmail }).sendMagicLink({
      email: "u@e.com",
      url: "https://link",
      token: "tok",
    });
    expect(sendEmail).toHaveBeenCalledWith({ to: "u@e.com", url: "https://link" });
  });

  it("never passes the raw token to the email sender (only the URL)", async () => {
    const sendEmail = vi.fn(async () => {});
    await magicLinkOptions({ sendEmail }).sendMagicLink({
      email: "u@e.com",
      url: "https://link",
      token: "SECRET_TOKEN",
    });
    expect(JSON.stringify((sendEmail as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "SECRET_TOKEN",
    );
  });
});

describe("resolveBaseUrl", () => {
  it("defaults to the prod auth origin", () => {
    expect(resolveBaseUrl(undefined)).toBe("https://auth.webhook.co");
  });

  it("allows http://localhost for dev", () => {
    expect(resolveBaseUrl("http://localhost:8788")).toBe("http://localhost:8788");
  });

  it("accepts an https:// origin", () => {
    expect(resolveBaseUrl("https://auth.staging.webhook.co")).toBe(
      "https://auth.staging.webhook.co",
    );
  });

  it("rejects a non-loopback http:// origin (would downgrade the session cookie to insecure)", () => {
    expect(() => resolveBaseUrl("http://staging.example.com")).toThrow();
    expect(() => resolveBaseUrl("http://localhost.evil.com")).toThrow();
  });
});

describe("buildAuthConfig", () => {
  it("wires Google + GitHub from the resolved secrets", () => {
    const c = buildAuthConfig(input(), cfgDeps());
    expect(c.socialProviders?.google?.clientId).toBe("google-id");
    expect(c.socialProviders?.google?.clientSecret).toBe("google-secret");
    expect(c.socialProviders?.github?.clientId).toBe("github-id");
    expect(c.socialProviders?.github?.clientSecret).toBe("github-secret");
  });

  it("uses a HOST-ONLY cookie — does NOT enable cross-subdomain cookie sharing", () => {
    expect(buildAuthConfig(input(), cfgDeps()).advanced?.crossSubDomainCookies?.enabled).not.toBe(
      true,
    );
  });

  it("EXPLICITLY disables cookieCache (DB-validated sessions; pinned against Better Auth's default)", () => {
    expect(buildAuthConfig(input(), cfgDeps()).session?.cookieCache?.enabled).toBe(false);
  });

  it("includes the magic-link plugin", () => {
    expect(buildAuthConfig(input(), cfgDeps()).plugins?.some((p) => p.id === "magic-link")).toBe(
      true,
    );
  });

  it("does NOT enable email+password at runtime (social + magic-link only)", () => {
    expect(buildAuthConfig(input(), cfgDeps()).emailAndPassword?.enabled).not.toBe(true);
  });

  it("wires the provided databaseHooks (the signup→bootstrap path)", () => {
    const databaseHooks = { user: { create: { after: vi.fn() } } } as never;
    expect(buildAuthConfig(input(), cfgDeps({ databaseHooks })).databaseHooks).toBe(databaseHooks);
  });

  it("sets the secret + base URL and trusts the app origin", () => {
    const c = buildAuthConfig(input(), cfgDeps());
    expect(c.baseURL).toBe("https://auth.webhook.co");
    expect(c.secret).toBe("test-secret");
    expect(c.trustedOrigins).toContain("https://app.webhook.co");
  });
});

describe("makeAuth", () => {
  it("resolves secret bindings + constructs an instance exposing a handler + a pool-close hook", async () => {
    const made = await makeAuth(ENV);
    expect(typeof made.handler).toBe("function");
    expect(typeof made.close).toBe("function");
    await expect(made.close()).resolves.toBeUndefined();
  });
});
