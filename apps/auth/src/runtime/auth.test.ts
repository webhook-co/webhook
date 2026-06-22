import { describe, expect, it, vi } from "vitest";

import { buildAuthConfig, magicLinkOptions, makeAuth, resolveBaseUrl } from "./auth";
import { makeMagicLinkRateLimit } from "./magic-link";
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

  it("sends when the durable rate limit allows", async () => {
    const sendEmail = vi.fn(async () => {});
    await magicLinkOptions({ sendEmail, rateLimit: async () => true }).sendMagicLink({
      email: "u@e.com",
      url: "https://link",
      token: "t",
    });
    expect(sendEmail).toHaveBeenCalledWith({ to: "u@e.com", url: "https://link" });
  });

  it("SILENTLY skips the send when the rate limit denies (no throw, no oracle)", async () => {
    const sendEmail = vi.fn(async () => {});
    const log = vi.fn();
    await expect(
      magicLinkOptions({ sendEmail, rateLimit: async () => false, log }).sendMagicLink({
        email: "u@e.com",
        url: "https://link",
        token: "t",
      }),
    ).resolves.toBeUndefined();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("magic_link.rate_limited");
  });

  it("checks the rate limiter with the recipient email before sending", async () => {
    const rateLimit = vi.fn(async () => true);
    await magicLinkOptions({ sendEmail: vi.fn(async () => {}), rateLimit }).sendMagicLink({
      email: "u@e.com",
      url: "https://link",
      token: "t",
    });
    expect(rateLimit).toHaveBeenCalledWith("u@e.com");
  });
});

describe("makeMagicLinkRateLimit", () => {
  function fakeKv() {
    const store = new Map<string, string>();
    return {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    };
  }
  const now = () => 1000;

  it("allows the first send, then denies once the per-email window is exhausted", async () => {
    const rl = makeMagicLinkRateLimit(fakeKv(), now);
    expect(await rl("u@e.com")).toBe(true);
    let denied = false;
    for (let i = 0; i < 12 && !denied; i++) denied = !(await rl("u@e.com"));
    expect(denied).toBe(true);
  });

  it("tracks distinct emails independently", async () => {
    const kv = fakeKv();
    const rl = makeMagicLinkRateLimit(kv, now);
    for (let i = 0; i < 12; i++) await rl("spammed@e.com"); // exhaust one address
    expect(await rl("fresh@e.com")).toBe(true); // a different address is unaffected
  });

  it("fails OPEN when the KV faults (never blocks login)", async () => {
    const kv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {},
    };
    expect(await makeMagicLinkRateLimit(kv, now)("u@e.com")).toBe(true);
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

  it("reads CF's trusted client-IP header for rate limiting (no shared per-path bucket on Workers)", () => {
    expect(buildAuthConfig(input(), cfgDeps()).advanced?.ipAddress?.ipAddressHeaders).toEqual([
      "cf-connecting-ip",
    ]);
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

// The Cloudflare Turnstile captcha gate (defense-in-depth on the public, email-sending magic-link endpoint).
// It's wired ONLY when a Turnstile secret is configured (prod), so local/test runs without the secret boot
// unchanged. When wired it gates EXACTLY /sign-in/magic-link (social + session stay ungated) and pins the
// action + the origin host so a token minted elsewhere can't be replayed against it.
describe("buildAuthConfig — Turnstile captcha", () => {
  const withTurnstile: ResolvedAuthSecrets = { ...SECRETS, turnstileSecretKey: "0xSECRET" };
  const captchaOptions = (baseURL: string) => {
    const plugin = buildAuthConfig({ baseURL, secrets: withTurnstile }, cfgDeps()).plugins?.find(
      (p) => p.id === "captcha",
    );
    return (plugin as { options: Record<string, unknown> } | undefined)?.options;
  };

  it("wires the Cloudflare Turnstile plugin when the secret is present", () => {
    const o = captchaOptions("https://auth.webhook.co");
    expect(o).toBeDefined();
    expect(o?.provider).toBe("cloudflare-turnstile");
    expect(o?.secretKey).toBe("0xSECRET");
  });

  it("gates ONLY the magic-link send (social + session stay ungated)", () => {
    expect(captchaOptions("https://auth.webhook.co")?.endpoints).toEqual(["/sign-in/magic-link"]);
  });

  it("pins the expected action (rejects a token minted for another action/site)", () => {
    expect(captchaOptions("https://auth.webhook.co")?.expectedAction).toBe("turnstile-spin-v1");
  });

  it("derives the allowed hostname from the configured origin (prod host)", () => {
    expect(captchaOptions("https://auth.webhook.co")?.allowedHostnames).toEqual([
      "auth.webhook.co",
    ]);
  });

  it("derives the allowed hostname for local dev (localhost, not the prod host)", () => {
    expect(captchaOptions("http://localhost:8788")?.allowedHostnames).toEqual(["localhost"]);
  });

  it("does NOT wire the captcha when no Turnstile secret is configured", () => {
    expect(buildAuthConfig(input(), cfgDeps()).plugins?.some((p) => p.id === "captcha")).toBe(
      false,
    );
  });

  it("keeps the magic-link plugin alongside the captcha", () => {
    const plugins = buildAuthConfig(
      { baseURL: "https://auth.webhook.co", secrets: withTurnstile },
      cfgDeps(),
    ).plugins;
    expect(plugins?.some((p) => p.id === "magic-link")).toBe(true);
    expect(plugins?.some((p) => p.id === "captcha")).toBe(true);
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
