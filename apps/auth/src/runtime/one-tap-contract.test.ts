import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthConfig } from "./auth";
import { SIGNIN_METHOD_BY_PATH } from "./signin-telemetry";
import { ONE_TAP_CALLBACK_URL_PATH } from "./urls";

import type { AuthConfigDeps, AuthConfigInput } from "./auth";
import type { ResolvedAuthSecrets } from "./env";

// THE CONTRACT TEST. Everything else about One Tap is a config assertion — this is the only test that
// runs a real `betterAuth()` instance end to end over a real ID token, and therefore the only one that
// fails if the wiring is present but INERT. Specifically it is the only thing standing between us and a
// silent `create.before` regression: if the name back-fill stops running, every config test still passes
// and only the persisted row is wrong.
//
// It touches no network and no database. Google's JWKS endpoint is stubbed at `globalThis.fetch` (which
// is what `betterFetch` calls through to), the signing key is generated per-run, and the adapter is
// better-auth's in-memory one — so the assertions are about OUR wiring, never about Google's uptime.

const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CLIENT_ID = "1234567890-abc123def456.apps.googleusercontent.com";
const KID = "test-key-1";

const SECRETS: ResolvedAuthSecrets = {
  betterAuthSecret: "test-secret-value-at-least-32-chars-long",
  credentialPepper: "cGVwcGVy",
  googleClientId: CLIENT_ID,
  googleClientSecret: "google-secret",
  githubClientId: "github-id",
  githubClientSecret: "github-secret",
  resendApiKey: "re_test",
};

// RS256 by hand over WebCrypto rather than pulling in `jose`. The repo has no jose dependency and signs
// its test JWTs with `crypto.subtle` (see apps/mcp/src/session-binding.test.ts), so this keeps a
// test-only signing helper from becoming a real dependency of a deployed Worker package.
const RSA_PARAMS = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

/** Sign `{header}.{payload}` with RS256 and return the compact JWS. */
async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: CryptoKey,
): Promise<string> {
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      RSA_PARAMS.name,
      key,
      new TextEncoder().encode(signingInput) as Uint8Array<ArrayBuffer>,
    ),
  );
  return `${signingInput}.${b64url(signature)}`;
}

let signingKey: CryptoKey;
let wrongKey: CryptoKey;
let jwks: { keys: unknown[] };

beforeEach(async () => {
  const pair = (await crypto.subtle.generateKey(RSA_PARAMS, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const other = (await crypto.subtle.generateKey(RSA_PARAMS, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  wrongKey = other.privateKey;

  // Only the fields a JWKS actually carries — `exportKey` also emits key_ops/ext, which have no place
  // in a published key set and would not appear in Google's.
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  jwks = { keys: [{ kty: pub.kty, n: pub.n, e: pub.e, alg: "RS256", use: "sig", kid: KID }] };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as Request)?.url ?? input);
      if (url.startsWith(GOOGLE_CERTS_URL)) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected outbound fetch in a hermetic test: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface TokenOverrides {
  audience?: string;
  issuer?: string;
  key?: CryptoKey;
  kid?: string;
  issuedAt?: number;
  expiresAt?: number;
  claims?: Record<string, unknown>;
}

/** A Google-shaped ID token, signed locally. Defaults are the happy path; each override is one attack. */
async function idToken(over: TokenOverrides = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const iat = over.issuedAt ?? now;
  return signJwt(
    { alg: "RS256", kid: over.kid ?? KID, typ: "JWT" },
    {
      iss: over.issuer ?? "https://accounts.google.com",
      aud: over.audience ?? CLIENT_ID,
      sub: "google-sub-123",
      iat,
      exp: over.expiresAt ?? now + 3600,
      email: "ada@example.dev",
      email_verified: true,
      name: "Ada Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
      picture: "https://example.dev/ada.png",
      ...over.claims,
    },
    over.key ?? signingKey,
  );
}

function makeInstance(over: Partial<ResolvedAuthSecrets> = {}, deps: Partial<AuthConfigDeps> = {}) {
  // The memory adapter treats a missing key as "model not found" rather than as an empty table, so every
  // model better-auth touches has to exist up front or the first lookup throws.
  const db: Record<string, unknown[]> = { user: [], account: [], session: [], verification: [] };
  const log = vi.fn();
  const input: AuthConfigInput = {
    baseURL: "https://auth.webhook.co",
    secrets: { ...SECRETS, ...over },
  };
  const auth = betterAuth(
    buildAuthConfig(input, {
      database: memoryAdapter(db) as unknown as AuthConfigDeps["database"],
      sendEmail: vi.fn(async () => {}),
      databaseHooks: undefined,
      log,
      ...deps,
    }),
  );
  return { auth, db, log };
}

const callback = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://auth.webhook.co${ONE_TAP_CALLBACK_URL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://auth.webhook.co", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("One Tap — the endpoint is mounted and reachable", () => {
  // Distinguishes THREE outcomes a single "it fails" assertion would blur together: 404 (never mounted),
  // "Google client ID is required" (mounted but the audience never resolved), and a real token rejection.
  // Only the third means the plugin is correctly wired.
  it("rejects a non-JWT with 400 'invalid id token' — mounted AND audience-resolved", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(callback({ idToken: "definitely-not-a-jwt" }));

    expect(res.status).toBe(400);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/invalid id token/i);
    expect(body.message).not.toMatch(/client ID is required/i);
  });

  it("is NOT mounted when Google is unconfigured — the gate is real, not decorative", async () => {
    const { auth } = makeInstance({ googleClientId: "", googleClientSecret: "" });
    const res = await auth.handler(callback({ idToken: "x" }));
    expect(res.status).toBe(404);
  });

  it("is NOT mounted when the client id is malformed", async () => {
    const { auth } = makeInstance({ googleClientId: "google-id" });
    expect((await auth.handler(callback({ idToken: "x" }))).status).toBe(404);
  });
});

describe("One Tap — token verification", () => {
  it("accepts a correctly signed token and establishes a session", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(callback({ idToken: await idToken() }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string; user?: { email?: string } };
    expect(body.token).toBeTruthy();
    expect(body.user?.email).toBe("ada@example.dev");
    expect(res.headers.get("set-cookie")).toMatch(/session/i);
  });

  it("rejects a token signed by the WRONG key", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(callback({ idToken: await idToken({ key: wrongKey }) }));
    expect(res.status).toBe(400);
  });

  // The audience pin is what makes an id token minted for SOME OTHER Google app useless here. Without
  // it, anyone with a Google app could mint a token for their own audience and sign in as that email.
  it("rejects a token minted for a DIFFERENT audience", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(
      callback({ idToken: await idToken({ audience: "999-evil.apps.googleusercontent.com" }) }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an EXPIRED token", async () => {
    const { auth } = makeInstance();
    const past = Math.floor(Date.now() / 1000) - 7200;
    const res = await auth.handler(
      callback({ idToken: await idToken({ issuedAt: past, expiresAt: past + 60 }) }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a token from the WRONG issuer", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(
      callback({ idToken: await idToken({ issuer: "https://evil.example" }) }),
    );
    expect(res.status).toBe(400);
  });

  // maxTokenAge is 1h, independent of `exp`: a token can be unexpired and still too old to replay.
  it("rejects a token older than the 1h max age even if it has not expired", async () => {
    const { auth } = makeInstance();
    const old = Math.floor(Date.now() / 1000) - 7200;
    const res = await auth.handler(
      callback({ idToken: await idToken({ issuedAt: old, expiresAt: old + 86400 }) }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a token whose kid is not in Google's JWKS", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(callback({ idToken: await idToken({ kid: "unknown-kid" }) }));
    expect(res.status).toBe(400);
  });
});

describe("One Tap — what lands in the database", () => {
  // THE REASON THIS FILE EXISTS. The one-tap plugin hands `handleOAuthUserInfo` an EMPTY provider
  // profile, so `socialProviders.google.mapProfileToUser` never runs and firstName/lastName would be
  // NULL — strictly worse data than the button One Tap replaces. Only an end-to-end run catches it.
  it("persists the EXACT given_name/family_name from the verified token", async () => {
    const { auth, db } = makeInstance();
    expect((await auth.handler(callback({ idToken: await idToken() }))).status).toBe(200);

    const user = (db.user as Array<Record<string, unknown>>)?.[0];
    expect(user).toBeDefined();
    expect(user?.firstName).toBe("Ada");
    expect(user?.lastName).toBe("Lovelace");
  });

  // THE DISCRIMINATING CASES. "Ada Lovelace" cannot prove the exact path ran, because `splitName` of the
  // composite name produces the identical answer — a test built on it passes just as happily when the
  // token path is dead and the fallback silently takes over. (An earlier draft of this file used
  // "Maria van Rijn" believing splitName would mangle it; it does not. splitName takes the FIRST token as
  // the first name and ALL the rest as the last name, so it agrees there too, and the mutation that
  // disabled the exact path went undetected.) These two fixtures are chosen because the exact claims and
  // the fallback genuinely disagree, which is the only way the assertion has teeth.
  it("uses the exact claims for a MIDDLE name, where splitName over-captures the surname", async () => {
    const { auth, db } = makeInstance();
    const token = await idToken({
      claims: {
        email: "abl@example.dev",
        name: "Ada Byron Lovelace",
        given_name: "Ada",
        family_name: "Lovelace",
      },
    });
    expect((await auth.handler(callback({ idToken: token }))).status).toBe(200);

    const user = (db.user as Array<Record<string, unknown>>)?.[0];
    expect(user?.firstName).toBe("Ada");
    // splitName would yield "Byron Lovelace" here. Only the exact claim gives "Lovelace".
    expect(user?.lastName).toBe("Lovelace");
    expect(user?.lastName).not.toBe("Byron Lovelace");
  });

  it("uses the exact claims for a CJK name, where splitName gets the order BACKWARDS", async () => {
    const { auth, db } = makeInstance();
    const token = await idToken({
      claims: {
        email: "lee@example.dev",
        // Family name first, as the composite name is conventionally written.
        name: "李 小龍",
        given_name: "小龍",
        family_name: "李",
      },
    });
    expect((await auth.handler(callback({ idToken: token }))).status).toBe(200);

    const user = (db.user as Array<Record<string, unknown>>)?.[0];
    // splitName would assign firstName "李" and lastName "小龍" — exactly reversed. This is the harm the
    // module header calls out, and the reason the exact path exists at all.
    expect(user?.firstName).toBe("小龍");
    expect(user?.lastName).toBe("李");
  });

  // Data minimization: the plugin explicitly writes `idToken` onto the account row. The stripping hook
  // must null it, or every One Tap sign-in leaves a live OIDC JWT at rest in the identity database.
  it("NEVER persists the raw id token on the account row", async () => {
    const { auth, db } = makeInstance();
    expect((await auth.handler(callback({ idToken: await idToken() }))).status).toBe(200);

    const account = (db.account as Array<Record<string, unknown>>)?.[0];
    expect(account).toBeDefined();
    expect(account?.idToken ?? null).toBeNull();
    expect(account?.accessToken ?? null).toBeNull();
    expect(account?.refreshToken ?? null).toBeNull();
  });

  it("does not mark a brand-new user as already onboarded", async () => {
    const { auth, db } = makeInstance();
    expect((await auth.handler(callback({ idToken: await idToken() }))).status).toBe(200);
    const user = (db.user as Array<Record<string, unknown>>)?.[0];
    expect(user?.onboardedAt ?? null).toBeNull();
  });

  // Second sign-in by the same person must LINK, not duplicate — and must not re-write the names.
  it("does not create a second user or clobber names on a repeat sign-in", async () => {
    const { auth, db } = makeInstance();
    await auth.handler(callback({ idToken: await idToken() }));
    await auth.handler(callback({ idToken: await idToken() }));

    expect((db.user as unknown[]).length).toBe(1);
    const user = (db.user as Array<Record<string, unknown>>)[0];
    expect(user?.firstName).toBe("Ada");
    expect(user?.lastName).toBe("Lovelace");
  });
});

// THE ACCOUNT-TAKEOVER GATE, end to end. A correctly SIGNED token whose `email_verified` is false must
// not produce a user. better-auth checks that flag only when linking to an existing row, never when
// creating one — so without our refusal hook this token would mint a first-class account bearing an
// address its holder has not proven, with their Google `sub` permanently linked to it.
describe("One Tap — an unverified Google email cannot create an account", () => {
  it("REFUSES a validly-signed token with email_verified: false", async () => {
    const { auth, db } = makeInstance();
    const token = await idToken({ claims: { email_verified: false } });

    const res = await auth.handler(callback({ idToken: token }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.user).toHaveLength(0);
    expect(db.account).toHaveLength(0);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // The claim can arrive as a string from some OIDC providers; better-auth coerces with toBoolean, and
  // a coerced-false must be refused exactly like a real false.
  it("REFUSES a string 'false' claim too", async () => {
    const { auth, db } = makeInstance();
    const res = await auth.handler(
      callback({ idToken: await idToken({ claims: { email_verified: "false" } }) }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.user).toHaveLength(0);
  });

  it("REFUSES a token with no email_verified claim at all", async () => {
    const { auth, db } = makeInstance();
    const res = await auth.handler(
      callback({ idToken: await idToken({ claims: { email_verified: undefined } }) }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(db.user).toHaveLength(0);
  });

  it("still admits the ordinary verified signup — the gate is not a blanket refusal", async () => {
    const { auth, db } = makeInstance();
    expect((await auth.handler(callback({ idToken: await idToken() }))).status).toBe(200);
    expect(db.user).toHaveLength(1);
  });
});

// The telemetry path map is a CONTRACT WITH BETTER-AUTH, and its own unit test could only compare
// literals to literals — it restated the map rather than checking it. An upstream rename would silently
// zero those counters with a green suite. These read the paths off a REAL instance's registered
// endpoints, which is the only thing that actually notices.
describe("sign-in telemetry — the path map matches better-auth's registered endpoints", () => {
  const pathOf = (key: string) => {
    const { auth } = makeInstance();
    return (auth.api as unknown as Record<string, { path?: string }>)[key]?.path;
  };

  it.each([
    ["oneTapCallback", "/one-tap/callback"],
    // The PATTERN, not a concrete provider — a concrete string here would never match in production.
    ["callbackOAuth", "/callback/:id"],
    ["magicLinkVerify", "/magic-link/verify"],
  ])("%s is still registered at %s", (key, expected) => {
    expect(pathOf(key)).toBe(expected);
  });

  it("every key in SIGNIN_METHOD_BY_PATH is a path better-auth actually registers", () => {
    const { auth } = makeInstance();
    const registered = new Set(
      Object.values(auth.api as unknown as Record<string, { path?: string }>)
        .map((e) => e?.path)
        .filter((p): p is string => typeof p === "string"),
    );
    for (const path of Object.keys(SIGNIN_METHOD_BY_PATH)) expect(registered).toContain(path);
  });
});

describe("One Tap — telemetry", () => {
  it("records the sign-in as one_tap, distinguishing it from the Google button", async () => {
    const { auth, log } = makeInstance();
    expect((await auth.handler(callback({ idToken: await idToken() }))).status).toBe(200);
    expect(log).toHaveBeenCalledWith("signin.method", { method: "one_tap" });
  });

  it("records NOTHING for a rejected token — an attempt is not a sign-in", async () => {
    const { auth, log } = makeInstance();
    await auth.handler(callback({ idToken: "not-a-jwt" }));
    expect(log).not.toHaveBeenCalledWith("signin.method", expect.anything());
  });
});

describe("One Tap — request-level hardening", () => {
  // The plugin performs the post-login redirect from `callbackURL`. better-auth's origin-check
  // middleware validates it against trustedOrigins; without that this is an open redirect.
  it("rejects a callbackURL outside trustedOrigins", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(
      callback({ idToken: await idToken(), callbackURL: "https://evil.example/steal" }),
    );
    expect(res.status).toBe(403);
  });

  it("accepts a relative callbackURL on this origin", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(
      callback({ idToken: await idToken(), callbackURL: "/session/handoff" }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects a body that is not JSON", async () => {
    const { auth } = makeInstance();
    const res = await auth.handler(
      callback("idToken=x", { "content-type": "text/plain;charset=UTF-8" }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a request with no idToken at all", async () => {
    const { auth } = makeInstance();
    expect((await auth.handler(callback({}))).status).toBe(400);
  });
});
