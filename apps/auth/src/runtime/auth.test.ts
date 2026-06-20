import { describe, expect, it, vi } from "vitest";

import { buildAuthConfig, magicLinkOptions, makeAuth } from "./auth";
import type { AuthEnv } from "./env";

// A1b-1 — the Better Auth runtime config. These tests pin the security-relevant wiring (the parts a
// later refactor could silently break): providers sourced from env, a HOST-ONLY cookie (the auth.→app.
// handoff is the backchannel session-exchange, NOT a shared cross-subdomain cookie — founder X-2),
// DB-validated sessions (no cookieCache), and single-use HASHED magic-link tokens. The full Better Auth
// instance (makeAuth → betterAuth(...) over a pg Pool) is integration-validated by build:cf, not here.

const ENV: AuthEnv = {
  HYPERDRIVE_AUTH: { connectionString: "postgres://auth@hd/db" },
  HYPERDRIVE_TENANT: { connectionString: "postgres://app@hd/db" },
  BETTER_AUTH_SECRET: "test-secret",
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GITHUB_CLIENT_ID: "github-id",
  GITHUB_CLIENT_SECRET: "github-secret",
  RESEND_API_KEY: "re_test",
};

const deps = () => ({ database: {} as never, sendEmail: vi.fn(async () => {}) });

describe("magicLinkOptions", () => {
  it("expires in 5 minutes and stores tokens hashed (never plaintext in the DB)", () => {
    const o = magicLinkOptions(deps());
    expect(o.expiresIn).toBe(300);
    expect(o.storeToken).toBe("hashed");
  });

  it("sendMagicLink forwards the recipient + URL to the injected email sender", async () => {
    const d = deps();
    const o = magicLinkOptions(d);
    await o.sendMagicLink({ email: "user@example.com", url: "https://link", token: "tok" });
    expect(d.sendEmail).toHaveBeenCalledWith({ to: "user@example.com", url: "https://link" });
  });

  it("never passes the raw token to the email sender (only the URL)", async () => {
    const d = deps();
    await magicLinkOptions(d).sendMagicLink({
      email: "u@e.com",
      url: "https://link",
      token: "SECRET_TOKEN",
    });
    expect(JSON.stringify((d.sendEmail as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "SECRET_TOKEN",
    );
  });
});

describe("buildAuthConfig", () => {
  it("wires Google + GitHub from env secrets", () => {
    const c = buildAuthConfig(ENV, deps());
    expect(c.socialProviders?.google?.clientId).toBe("google-id");
    expect(c.socialProviders?.google?.clientSecret).toBe("google-secret");
    expect(c.socialProviders?.github?.clientId).toBe("github-id");
    expect(c.socialProviders?.github?.clientSecret).toBe("github-secret");
  });

  it("uses a HOST-ONLY cookie — does NOT enable cross-subdomain cookie sharing", () => {
    const c = buildAuthConfig(ENV, deps());
    expect(c.advanced?.crossSubDomainCookies?.enabled).not.toBe(true);
  });

  it("EXPLICITLY disables cookieCache (DB-validated sessions; pinned against Better Auth's default)", () => {
    // Better Auth defaults cookieCache ON for non-stateful instances; setting it false explicitly keeps
    // the "a revoked session dies immediately" guarantee even if the storage model later changes.
    const c = buildAuthConfig(ENV, deps());
    expect(c.session?.cookieCache?.enabled).toBe(false);
  });

  it("includes the magic-link plugin", () => {
    const c = buildAuthConfig(ENV, deps());
    expect(c.plugins?.some((p) => p.id === "magic-link")).toBe(true);
  });

  it("does NOT enable email+password at runtime (social + magic-link only)", () => {
    const c = buildAuthConfig(ENV, deps());
    expect(c.emailAndPassword?.enabled).not.toBe(true);
  });

  it("sets the auth.webhook.co base URL + the secret from env, and trusts the app origin", () => {
    const c = buildAuthConfig(ENV, deps());
    expect(c.baseURL).toBe("https://auth.webhook.co");
    expect(c.secret).toBe("test-secret");
    expect(c.trustedOrigins).toContain("https://app.webhook.co");
  });

  it("honors an env-provided base URL (local dev over http://localhost)", () => {
    const c = buildAuthConfig({ ...ENV, AUTH_BASE_URL: "http://localhost:8788" }, deps());
    expect(c.baseURL).toBe("http://localhost:8788");
  });

  it("rejects a non-loopback http:// base URL (would downgrade the session cookie to insecure)", () => {
    expect(() =>
      buildAuthConfig({ ...ENV, AUTH_BASE_URL: "http://staging.example.com" }, deps()),
    ).toThrow();
  });

  it("accepts an https:// base URL", () => {
    const c = buildAuthConfig({ ...ENV, AUTH_BASE_URL: "https://auth.staging.webhook.co" }, deps());
    expect(c.baseURL).toBe("https://auth.staging.webhook.co");
  });
});

describe("makeAuth", () => {
  it("constructs a Better Auth instance exposing a handler + a pool-close hook", async () => {
    const made = makeAuth(ENV);
    expect(typeof made.handler).toBe("function");
    expect(typeof made.close).toBe("function");
    // close() must resolve (ends the per-request pool) without a live connection.
    await expect(made.close()).resolves.toBeUndefined();
  });
});
