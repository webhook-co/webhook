import { describe, expect, it, vi } from "vitest";

import {
  configuredSocialProviders,
  readAuthEnv,
  resolveOAuthMode,
  readIntrospectEnv,
  readSweepEnv,
  readNotifyEnv,
  readTokenEnv,
  resolveAuthSecrets,
  type AuthEnv,
} from "./env";

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
  // Prod provisions this unconditionally (gen-wrangler-prod.mjs), so the fixture mirrors that shape.
  TURNSTILE_SECRET_KEY: "0x-turnstile-secret",
};

// --- Local-dev hermetic modes ------------------------------------------------------------------------
// A developer with no Google/GitHub OAuth app and no Resend account must still be able to boot this Worker
// and sign in. Two EXPLICIT flags relax the contract; absence is never enough, because an implicit
// "missing ⇒ optional" would let a prod secret-rotation typo silently disable Google sign-in instead of
// failing loudly. Both flags are fenced against the production secret shape.
const STORE = { get: async () => "from-store" };

describe("readAuthEnv — OAUTH_MODE=optional", () => {
  it("still requires the OAuth secrets by default (no flag = the prod contract)", () => {
    const { GOOGLE_CLIENT_ID: _o, ...partial } = RAW;
    expect(() => readAuthEnv(partial)).toThrow(/GOOGLE_CLIENT_ID/);
  });

  it("boots without any OAuth secret when OAUTH_MODE=optional", () => {
    const {
      GOOGLE_CLIENT_ID: _a,
      GOOGLE_CLIENT_SECRET: _b,
      GITHUB_CLIENT_ID: _c,
      GITHUB_CLIENT_SECRET: _d,
      ...partial
    } = RAW;
    expect(() => readAuthEnv({ ...partial, OAUTH_MODE: "optional" })).not.toThrow();
  });

  it("still requires BETTER_AUTH_SECRET under the flag — it relaxes OAuth only", () => {
    const { BETTER_AUTH_SECRET: _o, ...partial } = RAW;
    expect(() => readAuthEnv({ ...partial, OAUTH_MODE: "optional" })).toThrow(/BETTER_AUTH_SECRET/);
  });

  // The fence: a Secrets Store binding is the shape only a deployed Worker has.
  it("REFUSES optional mode when an OAuth secret is a Secrets Store binding", () => {
    expect(() => readAuthEnv({ ...RAW, OAUTH_MODE: "optional", GOOGLE_CLIENT_ID: STORE })).toThrow(
      /refusing OAUTH_MODE=optional/,
    );
  });

  it("throws on an unknown OAUTH_MODE rather than guessing", () => {
    expect(() => readAuthEnv({ ...RAW, OAUTH_MODE: "opitonal" })).toThrow(/OAUTH_MODE/);
  });
});

// The fence itself, tested directly rather than only through readAuthEnv — it is the thing standing
// between a local-dev convenience and a production auth downgrade.
describe("resolveOAuthMode", () => {
  it("defaults to required when the flag is unset — production sets nothing", () => {
    expect(resolveOAuthMode({})).toBe("required");
  });

  // `.dev.vars` writes an unset key as `OAUTH_MODE=` — an empty string. See the email-transport note.
  it("treats an empty value as unset — a blank .dev.vars line must not throw", () => {
    expect(resolveOAuthMode({ OAUTH_MODE: "" })).toBe("required");
  });

  it("accepts an explicit required", () => {
    expect(resolveOAuthMode({ OAUTH_MODE: "required" })).toBe("required");
  });

  it("returns optional for plain-string secrets (the dev shape)", () => {
    expect(resolveOAuthMode({ ...RAW, OAUTH_MODE: "optional" })).toBe("optional");
  });

  it("returns optional when no OAuth secret is bound at all", () => {
    expect(resolveOAuthMode({ OAUTH_MODE: "optional" })).toBe("optional");
  });

  it("REFUSES optional against the production secret shape", () => {
    expect(() => resolveOAuthMode({ OAUTH_MODE: "optional", GITHUB_CLIENT_SECRET: STORE })).toThrow(
      /refusing OAUTH_MODE=optional/,
    );
  });

  it("names every store-bound secret it refused on", () => {
    const err = (() => {
      try {
        resolveOAuthMode({
          OAUTH_MODE: "optional",
          GOOGLE_CLIENT_ID: STORE,
          GITHUB_CLIENT_ID: STORE,
        });
        return "";
      } catch (e) {
        return String(e);
      }
    })();
    expect(err).toContain("GOOGLE_CLIENT_ID");
    expect(err).toContain("GITHUB_CLIENT_ID");
  });

  // "" is UNSET (covered above), not an unknown value. A real typo still fails closed.
  it("throws on an unknown value rather than guessing", () => {
    expect(() => resolveOAuthMode({ OAUTH_MODE: "OPTIONAL" })).toThrow(/OAUTH_MODE/);
    expect(() => resolveOAuthMode({ OAUTH_MODE: "opitonal" })).toThrow(/OAUTH_MODE/);
  });
});

// `pnpm dev:secrets` writes an unconfigured optional secret as `TURNSTILE_SECRET_KEY=` — an empty STRING.
// Treating that as "present but broken" made EVERY /api/auth/* request 500 on a generated .dev.vars.
// A Secrets Store binding that resolves empty is still a genuine prod misconfig and must still throw.
// The captcha gate exists to protect the PUBLIC, email-triggering magic-link endpoint. So "mail really
// sends" and "the gate is configured" must not be allowed to diverge: a local setup that sends real email
// with no captcha is the abuse surface prod is careful never to have. Prod always provisions Turnstile
// (gen-wrangler-prod lists it unconditionally for auth), so requiring it whenever email sends costs prod
// nothing and closes the local hole.
describe("readAuthEnv — Turnstile is required when email really sends", () => {
  it("REFUSES to boot when mail sends and Turnstile is not configured", () => {
    const { TURNSTILE_SECRET_KEY: _omit, ...noTurnstile } = RAW;
    expect(() => readAuthEnv(noTurnstile)).toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it("refuses a blank Turnstile secret just the same when mail sends", () => {
    expect(() => readAuthEnv({ ...RAW, TURNSTILE_SECRET_KEY: "" })).toThrow(/TURNSTILE_SECRET_KEY/);
  });

  // The escape hatch is coherent: with no real mail leaving the machine there is no abuse surface to guard.
  it("allows an unconfigured Turnstile when EMAIL_MODE=log", () => {
    const { TURNSTILE_SECRET_KEY: _omit, ...noTurnstile } = RAW;
    expect(() => readAuthEnv({ ...noTurnstile, EMAIL_MODE: "log" })).not.toThrow();
  });

  it("names the reason, so the fix is obvious rather than a guess", () => {
    const { TURNSTILE_SECRET_KEY: _omit, ...noTurnstile } = RAW;
    expect(() => readAuthEnv(noTurnstile)).toThrow(/EMAIL_MODE=log/);
  });
});

// A secret pasted into the Secrets Store with a trailing newline is an ordinary provisioning slip.
// Canonicalizing it HERE — once — is what keeps every consumer of the same secret in agreement. Leaving
// it to consumers had a real consequence: One Tap trimmed its client id before validating it while
// `socialProviders` used the raw value, so one stray byte gave a working One Tap prompt and a broken
// "Continue with Google" button.
describe("resolveAuthSecrets — canonicalization", () => {
  it("trims every resolved secret, so all consumers see the same value", async () => {
    const secrets = await resolveAuthSecrets(
      readAuthEnv({
        ...RAW,
        GOOGLE_CLIENT_ID: " 1234567890-abc.apps.googleusercontent.com\n",
        GOOGLE_CLIENT_SECRET: "  GOCSPX-secret  ",
        GITHUB_CLIENT_ID: "\tgh-id\n",
        RESEND_API_KEY: " re_test\n",
      }) as AuthEnv,
    );
    expect(secrets.googleClientId).toBe("1234567890-abc.apps.googleusercontent.com");
    expect(secrets.googleClientSecret).toBe("GOCSPX-secret");
    expect(secrets.githubClientId).toBe("gh-id");
    expect(secrets.resendApiKey).toBe("re_test");
  });
});

describe("resolveAuthSecrets — optional Turnstile", () => {
  // EMAIL_MODE=log because readAuthEnv now refuses a blank Turnstile when mail really sends — this test is
  // about the blank-STRING vs empty-BINDING distinction, not about the coupling.
  it("treats an empty STRING as not configured (the .dev.vars shape)", async () => {
    const secrets = await resolveAuthSecrets(
      readAuthEnv({ ...RAW, TURNSTILE_SECRET_KEY: "", EMAIL_MODE: "log" }) as AuthEnv,
    );
    expect(secrets.turnstileSecretKey).toBeUndefined();
  });

  it("treats whitespace as not configured too", async () => {
    const secrets = await resolveAuthSecrets(
      readAuthEnv({ ...RAW, TURNSTILE_SECRET_KEY: "   ", EMAIL_MODE: "log" }) as AuthEnv,
    );
    expect(secrets.turnstileSecretKey).toBeUndefined();
  });

  it("still resolves a real value", async () => {
    const secrets = await resolveAuthSecrets(
      readAuthEnv({ ...RAW, TURNSTILE_SECRET_KEY: "0x-real" }) as AuthEnv,
    );
    expect(secrets.turnstileSecretKey).toBe("0x-real");
  });

  // The prod invariant this check exists for, preserved: a BINDING that resolves empty is a misconfig.
  it("STILL throws when a Secrets Store binding resolves empty", async () => {
    await expect(
      resolveAuthSecrets(
        readAuthEnv({ ...RAW, TURNSTILE_SECRET_KEY: { get: async () => "" } }) as AuthEnv,
      ),
    ).rejects.toThrow(/turnstileSecretKey/);
  });
});

describe("configuredSocialProviders", () => {
  it("reports both configured in the production shape", () => {
    expect(configuredSocialProviders(RAW)).toEqual({ google: true, github: true });
  });

  it("reports a provider unconfigured when either half is missing", () => {
    const { GOOGLE_CLIENT_SECRET: _o, ...partial } = RAW;
    expect(configuredSocialProviders(partial)).toEqual({ google: false, github: true });
  });

  it("reports neither when no OAuth secret is set at all", () => {
    const {
      GOOGLE_CLIENT_ID: _a,
      GOOGLE_CLIENT_SECRET: _b,
      GITHUB_CLIENT_ID: _c,
      GITHUB_CLIENT_SECRET: _d,
      ...partial
    } = RAW;
    expect(configuredSocialProviders(partial)).toEqual({ google: false, github: false });
  });

  it("treats an empty string as unconfigured, not as configured", () => {
    expect(configuredSocialProviders({ ...RAW, GITHUB_CLIENT_ID: "" })).toEqual({
      google: true,
      github: false,
    });
  });

  it("counts a Secrets Store binding as configured (the production shape)", () => {
    expect(configuredSocialProviders({ ...RAW, GOOGLE_CLIENT_ID: STORE })).toEqual({
      google: true,
      github: true,
    });
  });
});

describe("readAuthEnv — EMAIL_MODE=log", () => {
  it("still requires RESEND_API_KEY by default", () => {
    const { RESEND_API_KEY: _o, ...partial } = RAW;
    expect(() => readAuthEnv(partial)).toThrow(/RESEND_API_KEY/);
  });

  it("boots without RESEND_API_KEY when EMAIL_MODE=log", () => {
    const { RESEND_API_KEY: _o, ...partial } = RAW;
    expect(() => readAuthEnv({ ...partial, EMAIL_MODE: "log" })).not.toThrow();
  });

  it("REFUSES log mode when RESEND_API_KEY is a Secrets Store binding", () => {
    expect(() => readAuthEnv({ ...RAW, EMAIL_MODE: "log", RESEND_API_KEY: STORE })).toThrow(
      /refusing EMAIL_MODE=log/,
    );
  });
});

describe("resolveAuthSecrets — under the hermetic flags", () => {
  it("resolves the relaxed secrets to empty strings instead of throwing", async () => {
    const {
      GOOGLE_CLIENT_ID: _a,
      GOOGLE_CLIENT_SECRET: _b,
      GITHUB_CLIENT_ID: _c,
      GITHUB_CLIENT_SECRET: _d,
      RESEND_API_KEY: _e,
      ...partial
    } = RAW;
    const env = readAuthEnv({ ...partial, OAUTH_MODE: "optional", EMAIL_MODE: "log" });
    const secrets = await resolveAuthSecrets(env);
    expect(secrets.googleClientId).toBe("");
    expect(secrets.resendApiKey).toBe("");
    // The non-relaxed ones still resolve for real.
    expect(secrets.betterAuthSecret).toBe("secret");
  });

  // The empty-secret fail-closed check must stay live for everything the flags did NOT relax.
  it("still throws on an empty BETTER_AUTH_SECRET under the flags", async () => {
    const env = readAuthEnv({ ...RAW, OAUTH_MODE: "optional", EMAIL_MODE: "log" }) as AuthEnv;
    await expect(
      resolveAuthSecrets({ ...env, BETTER_AUTH_SECRET: { get: async () => "" } } as AuthEnv),
    ).rejects.toThrow(/betterAuthSecret/);
  });

  it("without the flags, an empty OAuth secret still fails closed", async () => {
    const env = readAuthEnv({ ...RAW }) as AuthEnv;
    await expect(
      resolveAuthSecrets({ ...env, GOOGLE_CLIENT_ID: { get: async () => "" } } as AuthEnv),
    ).rejects.toThrow(/googleClientId/);
  });
});

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

describe("readSweepEnv", () => {
  it("returns the env when HYPERDRIVE_SWEEPER is bound", () => {
    const env = { HYPERDRIVE_SWEEPER: { connectionString: "postgres://sweeper@hd/db" } };
    expect(readSweepEnv(env)).toMatchObject(env);
  });

  it("throws (fail-closed) when HYPERDRIVE_SWEEPER is absent or malformed", () => {
    expect(() => readSweepEnv({})).toThrow(/HYPERDRIVE_SWEEPER/);
    expect(() => readSweepEnv({ HYPERDRIVE_SWEEPER: {} })).toThrow(/HYPERDRIVE_SWEEPER/);
    expect(() => readSweepEnv({ HYPERDRIVE_SWEEPER: { connectionString: "" } })).toThrow(
      /HYPERDRIVE_SWEEPER/,
    );
  });
});

describe("readNotifyEnv", () => {
  const OK = {
    HYPERDRIVE_NOTIFIER: { connectionString: "postgres://notifier@hd/db" },
    RESEND_API_KEY: "re_test",
  };

  it("returns the env when HYPERDRIVE_NOTIFIER + RESEND_API_KEY are present", () => {
    expect(readNotifyEnv(OK)).toMatchObject(OK);
  });

  it("throws (fail-closed) when the Hyperdrive binding is absent or malformed", () => {
    expect(() => readNotifyEnv({ RESEND_API_KEY: "re_test" })).toThrow(/HYPERDRIVE_NOTIFIER/);
    expect(() => readNotifyEnv({ ...OK, HYPERDRIVE_NOTIFIER: { connectionString: "" } })).toThrow(
      /HYPERDRIVE_NOTIFIER/,
    );
  });

  it("throws (fail-closed) when RESEND_API_KEY is missing", () => {
    expect(() => readNotifyEnv({ HYPERDRIVE_NOTIFIER: OK.HYPERDRIVE_NOTIFIER })).toThrow(
      /RESEND_API_KEY/,
    );
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
      // RAW mirrors the prod shape, which always provisions Turnstile.
      turnstileSecretKey: "0x-turnstile-secret",
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

  // TURNSTILE_SECRET_KEY is OPTIONAL (the captcha is defense-in-depth; absent → the plugin is simply not
  // wired, so local/test boot without it). When present it must resolve to a non-empty string.
  it("leaves turnstileSecretKey undefined when the secret is not configured", async () => {
    const { TURNSTILE_SECRET_KEY: _omit, ...noTurnstile } = RAW;
    const resolved = await resolveAuthSecrets(readAuthEnv({ ...noTurnstile, EMAIL_MODE: "log" }));
    expect(resolved.turnstileSecretKey).toBeUndefined();
  });

  it("resolves turnstileSecretKey when configured (plain string)", async () => {
    const env = readAuthEnv({ ...RAW, TURNSTILE_SECRET_KEY: "0xTURNSTILE" }) as AuthEnv;
    expect((await resolveAuthSecrets(env)).turnstileSecretKey).toBe("0xTURNSTILE");
  });

  it("resolves turnstileSecretKey from a Secrets Store binding via .get()", async () => {
    const get = vi.fn(async () => "0xFROM_STORE");
    const env = readAuthEnv({ ...RAW, TURNSTILE_SECRET_KEY: { get } }) as AuthEnv;
    expect((await resolveAuthSecrets(env)).turnstileSecretKey).toBe("0xFROM_STORE");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("fails closed when TURNSTILE_SECRET_KEY is present but resolves EMPTY (never run the gate keyless)", async () => {
    const env = readAuthEnv({ ...RAW, TURNSTILE_SECRET_KEY: { get: async () => "" } }) as AuthEnv;
    await expect(resolveAuthSecrets(env)).rejects.toThrow(/turnstileSecretKey/);
  });
});

// /token mints credentials AND, when a refresh is denied for lost membership, revokes the grant and evicts
// its cascaded keys from the shared principal cache. That eviction is the step that actually stops the
// credential at api./mcp./engine — without it a revoked key keeps authenticating for the cache TTL. So a
// deploy that forgets the KV_AUTHZ binding must fail LOUDLY on the first /token request, not silently skip
// the eviction forever.
describe("readTokenEnv", () => {
  const TOKEN_RAW = {
    HYPERDRIVE_TENANT: { connectionString: "postgres://app@hd/db" },
    CREDENTIAL_PEPPER: "cGVwcGVy",
    AUDIT_CHAIN_HMAC_KEY: "a2V5",
    OAUTH_KV: {},
    DEVICE_KV: {},
    KV_AUTHZ: {},
  };

  it("accepts a fully-bound token env", () => {
    expect(() => readTokenEnv({ ...TOKEN_RAW })).not.toThrow();
  });

  it("fails closed, naming the binding, when KV_AUTHZ is missing", () => {
    const { KV_AUTHZ: _omitted, ...withoutCache } = TOKEN_RAW;
    expect(() => readTokenEnv(withoutCache)).toThrow(/KV_AUTHZ/);
  });

  it.each(["OAUTH_KV", "DEVICE_KV", "KV_AUTHZ"])("fails closed when %s is not an object", (key) => {
    expect(() => readTokenEnv({ ...TOKEN_RAW, [key]: "not-a-binding" })).toThrow(new RegExp(key));
  });

  it("fails closed on a missing secret, naming it and never its value", () => {
    const { CREDENTIAL_PEPPER: _omitted, ...withoutPepper } = TOKEN_RAW;
    expect(() => readTokenEnv(withoutPepper)).toThrow(/CREDENTIAL_PEPPER/);
  });

  it("fails closed on a malformed Hyperdrive binding", () => {
    expect(() => readTokenEnv({ ...TOKEN_RAW, HYPERDRIVE_TENANT: {} })).toThrow(
      /HYPERDRIVE_TENANT/,
    );
  });
});
