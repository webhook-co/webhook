import { type CachedSealedSecret } from "@webhook-co/db";
import { serializeVerifyTokenSecret } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import {
  dispatchGetHandshake,
  dispatchPostHandshake,
  ebayChallengeResponse,
  xCrcResponse,
} from "../src/handshake";

const enc = new TextEncoder();

// The GET verification-handshake dispatcher. PR1 = the NO-SECRET protocols (Dropbox + Adobe I/O
// `?challenge=` bare echo; Adobe Sign `X-AdobeSign-ClientId` header echo). PR2a adds X/Twitter CRC
// (`crc_token` → HMAC under the endpoint's unsealed `x` consumer secret). PR2b adds Meta (`hub.mode=
// subscribe` → echo `hub.challenge` iff `hub.verify_token` matches the sealed verify-token). eBay is PR3.

const url = (qs: string) => new URL(`https://wbhk.my/whep_tok${qs}`);
const hdrs = (h: Record<string, string> = {}) => new Headers(h);
const NO_SECRETS: CachedSealedSecret[] = [];
const unsealNever = async (): Promise<string> => {
  throw new Error("unseal must not be called for a no-secret handshake");
};

// X/Twitter CRC gold vector (HMAC independently verified): the fake consumer secret keys HMAC-SHA256 over
// the crc_token to exactly `responseToken`. A fixed TEST fixture — not a live credential.
const GOLD = {
  crcToken: "9b4507b3-9040-4669-9ca3-6b94edb50553",
  consumerSecret: "z3ZX4v7mAAUGykl3EcmkqbartmuW8VFOOzCloLx9Q45P0hLrFu", // gitleaks:allow — fake test fixture
  responseToken: "sha256=Cytd4Sq+NvEcV3MMrXxWJGJx5A+y/lXzzU2Maartkx8=",
};

describe("dispatchGetHandshake — no-secret protocols", () => {
  it("Dropbox / Adobe I/O: echoes ?challenge= bare as text/plain with nosniff (gold vector abc123)", async () => {
    const res = await dispatchGetHandshake(
      url("?challenge=abc123"),
      hdrs(),
      NO_SECRETS,
      unsealNever,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff"); // Dropbox REQUIRES nosniff
    // token-URL hygiene (uniform with the liveness path): keep the token URL out of referers + indexes
    expect(res!.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res!.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res!.text()).toBe("abc123");
  });

  it("the challenge echo is INERT: a hostile ?challenge=<script> is returned verbatim as text/plain (no XSS)", async () => {
    const res = await dispatchGetHandshake(
      url("?challenge=%3Cscript%3Ealert(1)%3C%2Fscript%3E"),
      hdrs(),
      NO_SECRETS,
      unsealNever,
    );
    expect(res).not.toBeNull();
    expect(res!.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res!.text()).toBe("<script>alert(1)</script>"); // echoed verbatim, but inert
  });

  it("Adobe Sign: echoes the X-AdobeSign-ClientId header back on a 200 (no body)", async () => {
    const res = await dispatchGetHandshake(
      url(""),
      hdrs({ "X-AdobeSign-ClientId": "client-abc-123" }),
      NO_SECRETS,
      unsealNever,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("x-adobesign-clientid")).toBe("client-abc-123");
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res!.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res!.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res!.text()).toBe("");
  });

  it("returns null for a non-handshake GET (no challenge param, no adobe header) → falls through to capture", async () => {
    expect(await dispatchGetHandshake(url(""), hdrs(), NO_SECRETS, unsealNever)).toBeNull();
    expect(await dispatchGetHandshake(url("?foo=bar"), hdrs(), NO_SECRETS, unsealNever)).toBeNull();
  });

  it("returns null for an EMPTY ?challenge= (degenerate, not a real handshake)", async () => {
    expect(
      await dispatchGetHandshake(url("?challenge="), hdrs(), NO_SECRETS, unsealNever),
    ).toBeNull();
  });

  it("does NOT echo the secret-based protocols' params via the no-secret path (Meta hub.challenge / eBay challenge_code → null)", async () => {
    // hub.challenge is a DISTINCT param from `challenge` — must not be caught by the bare-echo path.
    expect(
      await dispatchGetHandshake(
        url("?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=t"),
        hdrs(),
        NO_SECRETS,
        unsealNever,
      ),
    ).toBeNull();
    expect(
      await dispatchGetHandshake(url("?challenge_code=71745723"), hdrs(), NO_SECRETS, unsealNever),
    ).toBeNull();
  });
});

describe("dispatchGetHandshake — X/Twitter CRC (crc_token, secret-based)", () => {
  // Only `.provider` is read off the sealed secret here; the unseal is injected (the engine owns the KEK).
  const xSealed = { provider: "x" } as CachedSealedSecret;

  it("crc_token → unseals the endpoint's `x` secret and returns the HMAC response_token (gold vector)", async () => {
    const res = await dispatchGetHandshake(
      url(`?crc_token=${GOLD.crcToken}`),
      hdrs(),
      [xSealed],
      async (cached) => {
        expect(cached.provider).toBe("x"); // it unseals the X secret, not another provider's
        return GOLD.consumerSecret;
      },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ response_token: GOLD.responseToken });
  });

  it("crc_token but NO `x` secret on the endpoint → null (not a resolvable handshake, never unseals)", async () => {
    const res = await dispatchGetHandshake(url("?crc_token=abc"), hdrs(), NO_SECRETS, unsealNever);
    expect(res).toBeNull();
  });
});

describe("dispatchGetHandshake — Meta hub.challenge verification (verify-token, secret-based)", () => {
  const metaSealed = { provider: "meta" } as CachedSealedSecret;
  const VERIFY_TOKEN = "my-meta-hub-verify-token";
  const metaUrl = (challenge: string, verifyToken: string, mode = "subscribe") =>
    new URL(
      `https://wbhk.my/whep_tok?hub.mode=${mode}&hub.challenge=${challenge}&hub.verify_token=${verifyToken}`,
    );
  // The endpoint's sealed `meta` secret unseals to the typed verify-token blob (db sealed it that way).
  const unsealVerifyToken = async (cached: CachedSealedSecret): Promise<string> => {
    expect(cached.provider).toBe("meta"); // the handshake only unseals meta secrets
    return serializeVerifyTokenSecret(VERIFY_TOKEN);
  };

  it("echoes hub.challenge as text/plain (200) when the verify-token matches", async () => {
    const res = await dispatchGetHandshake(
      metaUrl("CHALLENGE_1158201444", VERIFY_TOKEN),
      hdrs(),
      [metaSealed],
      unsealVerifyToken,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff"); // inert echo
    expect(res!.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await res!.text()).toBe("CHALLENGE_1158201444"); // bare challenge, the value Meta expects
  });

  it("returns 403 (no echo) when a verify-token IS configured but the presented one does NOT match", async () => {
    const res = await dispatchGetHandshake(
      metaUrl("CHALLENGE_1158201444", "attacker-guess"),
      hdrs(),
      [metaSealed],
      unsealVerifyToken,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.text()).not.toContain("CHALLENGE_1158201444"); // never echoes on mismatch
  });

  it("returns null (falls through to capture) when only a NON-verify-token meta secret exists (the app-secret)", async () => {
    const res = await dispatchGetHandshake(
      metaUrl("CHALLENGE_1", "any"),
      hdrs(),
      [metaSealed],
      async () => "raw-meta-app-secret-not-a-blob", // a signing secret, not a verify-token blob
    );
    expect(res).toBeNull();
  });

  it("returns null when the endpoint has no meta secret at all (not a resolvable handshake)", async () => {
    expect(
      await dispatchGetHandshake(metaUrl("C", "t"), hdrs(), NO_SECRETS, unsealNever),
    ).toBeNull();
  });

  it("ignores a non-subscribe hub.mode (not a verification handshake)", async () => {
    expect(
      await dispatchGetHandshake(
        metaUrl("C", VERIFY_TOKEN, "unsubscribe"),
        hdrs(),
        [metaSealed],
        unsealVerifyToken,
      ),
    ).toBeNull();
  });

  it("supports verify-token ROTATION: echoes if ANY configured verify-token matches", async () => {
    const oldT = { provider: "meta" } as CachedSealedSecret;
    const newT = { provider: "meta" } as CachedSealedSecret;
    const blob = new Map<CachedSealedSecret, string>([
      [oldT, "old-verify-token"],
      [newT, "new-verify-token"],
    ]);
    const res = await dispatchGetHandshake(
      metaUrl("C", "new-verify-token"),
      hdrs(),
      [oldT, newT],
      async (c) => serializeVerifyTokenSecret(blob.get(c)!),
    );
    expect(res!.status).toBe(200);
    expect(await res!.text()).toBe("C");
  });

  it("only unseals meta secrets (a co-located non-meta secret is never touched)", async () => {
    const xSealed = { provider: "x" } as CachedSealedSecret;
    const res = await dispatchGetHandshake(
      metaUrl("C", VERIFY_TOKEN),
      hdrs(),
      [xSealed, metaSealed],
      unsealVerifyToken, // asserts cached.provider === "meta" — never invoked for the x secret
    );
    expect(res!.status).toBe(200);
  });
});

describe("dispatchGetHandshake — Okta Event Hooks verification (no-secret header echo)", () => {
  it('echoes X-Okta-Verification-Challenge as {"verification":...} JSON', async () => {
    const res = await dispatchGetHandshake(
      url(""),
      hdrs({ "X-Okta-Verification-Challenge": "okta-challenge-abc" }),
      NO_SECRETS,
      unsealNever,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toMatch(/application\/json/);
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res!.json()).toEqual({ verification: "okta-challenge-abc" });
  });

  it("returns null without the Okta header (falls through)", async () => {
    expect(await dispatchGetHandshake(url(""), hdrs(), NO_SECRETS, unsealNever)).toBeNull();
  });
});

describe("dispatchPostHandshake — no-secret POST subscription handshakes", () => {
  const postUrl = (qs = "") => new URL(`https://wbhk.my/whep_tok${qs}`);

  it("Microsoft Graph: echoes ?validationToken= as text/plain (URL-decoded)", async () => {
    const res = dispatchPostHandshake(
      postUrl("?validationToken=ABC%20123"),
      hdrs(),
      enc.encode(""),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res!.text()).toBe("ABC 123");
  });

  it("Twitch: webhook_callback_verification header + body.challenge → echo challenge as text/plain", async () => {
    const res = dispatchPostHandshake(
      postUrl(),
      hdrs({ "Twitch-Eventsub-Message-Type": "webhook_callback_verification" }),
      enc.encode(JSON.stringify({ challenge: "pogchamp-kappa-360noscope-vohiyo" })),
    );
    expect(res).not.toBeNull();
    expect(await res!.text()).toBe("pogchamp-kappa-360noscope-vohiyo");
  });

  it("Twitch: a real notification message (not verification) → null", () => {
    expect(
      dispatchPostHandshake(
        postUrl(),
        hdrs({ "Twitch-Eventsub-Message-Type": "notification" }),
        enc.encode(JSON.stringify({ subscription: { type: "x" }, event: { id: "1" } })),
      ),
    ).toBeNull();
  });

  it("monday: body {challenge} → {challenge} JSON", async () => {
    const res = dispatchPostHandshake(
      postUrl(),
      hdrs(),
      enc.encode(JSON.stringify({ challenge: "mon-123" })),
    );
    expect(res).not.toBeNull();
    expect(res!.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res!.json()).toEqual({ challenge: "mon-123" });
  });

  it("does NOT catch a Slack url_verification body (has `type`) — left to the Slack path", () => {
    expect(
      dispatchPostHandshake(
        postUrl(),
        hdrs(),
        enc.encode(JSON.stringify({ type: "url_verification", challenge: "slack-c" })),
      ),
    ).toBeNull();
  });

  it("does NOT catch a real event body (has `event`) or a non-JSON / non-handshake POST", () => {
    expect(
      dispatchPostHandshake(
        postUrl(),
        hdrs(),
        enc.encode(JSON.stringify({ event: { type: "x" }, challenge: "c" })),
      ),
    ).toBeNull();
    expect(dispatchPostHandshake(postUrl(), hdrs(), enc.encode("not json"))).toBeNull();
    expect(
      dispatchPostHandshake(postUrl(), hdrs(), enc.encode(JSON.stringify({ foo: "bar" }))),
    ).toBeNull();
  });
});

describe("dispatchGetHandshake — eBay Marketplace Account Deletion (challenge_code, verify-token)", () => {
  const ebaySealed = { provider: "ebay" } as CachedSealedSecret;
  const EBAY_TOKEN = "webhook-co-ebay-verify-token-0123456789abcdef";
  const ebayUrl = (challengeCode: string) =>
    new URL(`https://wbhk.my/t/ebay-acct-deletion?challenge_code=${challengeCode}`);

  it("responds with hex(SHA256(challengeCode + verifyToken + endpoint)) — the gold vector", async () => {
    const res = await dispatchGetHandshake(
      ebayUrl("71745723-9b5e-4f8a-bc11-9f0e2a7d4c63"),
      hdrs(),
      [ebaySealed],
      async (cached) => {
        expect(cached.provider).toBe("ebay"); // only unseals ebay secrets
        return serializeVerifyTokenSecret(EBAY_TOKEN);
      },
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toMatch(/application\/json/);
    // endpoint hashed = the request URL minus the query (https://wbhk.my/t/ebay-acct-deletion)
    expect(await res!.json()).toEqual({
      challengeResponse: "d24cd543fe79a6b0b79e99e0b27939b4a01fce883ae11a63ca875183a5a07ba4",
    });
  });

  it("returns null when no ebay verify-token is configured (only an app-creds secret)", async () => {
    const res = await dispatchGetHandshake(
      ebayUrl("abc"),
      hdrs(),
      [ebaySealed],
      async () => JSON.stringify({ clientId: "c", clientSecret: "s" }), // app creds, not a verify-token
    );
    expect(res).toBeNull();
  });

  it("returns null when the endpoint has no ebay secret at all", async () => {
    expect(await dispatchGetHandshake(ebayUrl("abc"), hdrs(), NO_SECRETS, unsealNever)).toBeNull();
  });
});

describe("ebayChallengeResponse — byte-exact gold vector", () => {
  it("hashes challengeCode + verifyToken + endpoint to lowercase hex (independently verified)", async () => {
    const res = await ebayChallengeResponse(
      "71745723-9b5e-4f8a-bc11-9f0e2a7d4c63",
      "webhook-co-ebay-verify-token-0123456789abcdef",
      "https://wbhk.my/t/ebay-acct-deletion",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({
      challengeResponse: "d24cd543fe79a6b0b79e99e0b27939b4a01fce883ae11a63ca875183a5a07ba4",
    });
  });
});

describe("xCrcResponse — X/Twitter Account Activity CRC (byte-exact gold vector)", () => {
  // The response is JSON {"response_token":"sha256="+base64(HMAC-SHA256(consumer_secret, crc_token))}.
  // base64 is STANDARD (+/), the `sha256=` prefix is literal, the key is the app's CONSUMER secret.
  // Gold vector (HMAC verified independently): a known crc_token + consumer secret → the exact token.
  it("computes the response_token for the gold vector", async () => {
    const res = await xCrcResponse(GOLD.crcToken, GOLD.consumerSecret);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    // browser-safety headers, uniform with the echoes + the GET-liveness path (token-URL hygiene)
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.json()).toEqual({ response_token: GOLD.responseToken });
  });
});
