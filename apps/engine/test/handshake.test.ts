import { type CachedSealedSecret } from "@webhook-co/db";
import { describe, expect, it } from "vitest";

import { dispatchGetHandshake, xCrcResponse } from "../src/handshake";

// The GET verification-handshake dispatcher. PR1 = the NO-SECRET protocols (Dropbox + Adobe I/O
// `?challenge=` bare echo; Adobe Sign `X-AdobeSign-ClientId` header echo). PR2a adds X/Twitter CRC
// (`crc_token` → HMAC under the endpoint's unsealed `x` consumer secret). Meta/eBay are later PRs.

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
