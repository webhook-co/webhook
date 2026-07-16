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

  it("preserves the provided databaseHooks (the signup→bootstrap path) AND composes in account-token stripping", async () => {
    const userAfter = vi.fn();
    const databaseHooks = { user: { create: { after: userAfter } } } as never;
    const hooks = buildAuthConfig(input(), cfgDeps({ databaseHooks })).databaseHooks;
    // signup→bootstrap hook passes through untouched…
    expect(hooks?.user?.create?.after).toBe(userAfter);
    // …and every auth instance strips the unused provider OAuth tokens on account write (data minimization).
    const stripped = await hooks?.account?.create?.before?.({
      accessToken: "x",
      providerId: "google",
    });
    expect(stripped).toEqual({ data: { accessToken: null, refreshToken: null, idToken: null } });
  });

  it("does NOT enable storeAccountCookie (it would seed a cookie from in-memory tokens, bypassing the DB strip)", () => {
    // The stripping hook nulls tokens on DB write; storeAccountCookie would put the fresh in-memory provider
    // tokens into a cookie on re-auth — an exposure the DB strip can't reach. Keep it off.
    const account = buildAuthConfig(input(), cfgDeps()).account as
      { storeAccountCookie?: boolean } | undefined;
    expect(account?.storeAccountCookie).not.toBe(true);
  });

  it("PINS the account-linking policy explicitly (not Better Auth defaults)", () => {
    // Linking is an account-takeover surface and an email-change flow will lean on it, so the policy is
    // spelled out rather than inherited. This test is the regression pin: a config edit that drops, flips, OR
    // ADDS a key here must fail — hence toEqual (exact), not toMatchObject (subset). Adding e.g.
    // `updateUserInfoOnLink: true` (lets a linked provider overwrite local profile fields) must not slip
    // through unnoticed. See ADR-0118.
    const linking = buildAuthConfig(input(), cfgDeps()).account?.accountLinking;
    expect(linking).toEqual({
      enabled: true, // keep verified-email implicit linking on…
      disableImplicitLinking: false, // …explicitly
      trustedProviders: [], // no provider linked without a verified incoming email
      requireLocalEmailVerified: true, // never implicitly link into an UNVERIFIED local account (anti-pre-hijack)
      allowDifferentEmails: true, // a user who changed their email can still re-link their provider
      allowUnlinkingAll: false, // never strand the last sign-in method
      updateUserInfoOnLink: false, // a linked provider must never overwrite the user's own name/avatar
    });
  });

  it("pins updateUserInfoOnLink OFF explicitly — the default is not load-bearing", () => {
    // The block above already fails if someone ADDS `updateUserInfoOnLink: true` (toEqual is exact). What it
    // cannot see is better-auth CHANGING THE DEFAULT: `applyUpdateUserInfoOnLink` gates on
    // `accountLinking?.updateUserInfoOnLink !== true`, so an upstream flip to default-true would clobber
    // profiles while our config object — and therefore that assertion — stayed byte-identical and green.
    //
    // What it would clobber is not hypothetical: it does
    // `updateUser(userId, { name, image, ...additionalUserFields })` with the PROVIDER's values, and this
    // surface ships an editable display name and an avatar upload. Connect Google, lose the name you typed.
    // (An uploaded avatar survives — resolveAvatarSource prefers the R2 image_key over the provider `image`
    // — but the name does not.) Pinning it false costs nothing and makes the block's "PINNED (not riding
    // Better Auth defaults)" claim true of every key, which it was not.
    const linking = buildAuthConfig(input(), cfgDeps()).account?.accountLinking;
    expect(linking?.updateUserInfoOnLink).toBe(false);
  });

  it("sets the secret + base URL and trusts the app origin", () => {
    const c = buildAuthConfig(input(), cfgDeps());
    expect(c.baseURL).toBe("https://auth.webhook.co");
    expect(c.secret).toBe("test-secret");
    expect(c.trustedOrigins).toContain("https://app.webhook.co");
  });

  // The onboarding pre-fill is LOAD-BEARING on these input flags, and the failure is SILENT. Better Auth runs
  // mapProfileToUser's output through the same input filter as a client body, dropping any `input: false`
  // field — so with the name fields at `input: false` the provider's given/family name never persisted and
  // the pre-fill was dead with no error. These assertions pin the fix so a refactor can't quietly revert it.
  it("declares firstName/lastName as input:true so mapProfileToUser actually persists them", () => {
    const fields = (
      buildAuthConfig(input(), cfgDeps()).user as {
        additionalFields?: Record<string, { input?: boolean }>;
      }
    ).additionalFields;
    expect(fields?.firstName?.input).toBe(true);
    expect(fields?.lastName?.input).toBe(true);
  });

  it("keeps onboardedAt as input:false — the gate flag is never client-settable", () => {
    const fields = (
      buildAuthConfig(input(), cfgDeps()).user as {
        additionalFields?: Record<string, { input?: boolean }>;
      }
    ).additionalFields;
    // input defaults to false in Better Auth, so accept either explicit false or omitted — never true.
    expect(fields?.onboardedAt?.input).not.toBe(true);
  });

  it("maps the Google given/family name onto the columns (pre-fill source)", () => {
    const google = buildAuthConfig(input(), cfgDeps()).socialProviders?.google as {
      mapProfileToUser?: (p: { given_name?: string; family_name?: string }) => unknown;
    };
    expect(google.mapProfileToUser?.({ given_name: "Ada", family_name: "Lovelace" })).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("splits the GitHub single-name into a first/last guess (corrected on the onboarding screen)", () => {
    const github = buildAuthConfig(input(), cfgDeps()).socialProviders?.github as {
      mapProfileToUser?: (p: { name?: string | null }) => unknown;
    };
    expect(github.mapProfileToUser?.({ name: "Ada Lovelace" })).toMatchObject({
      firstName: "Ada",
      lastName: "Lovelace",
    });
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
