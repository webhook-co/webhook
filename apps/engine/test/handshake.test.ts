import { describe, expect, it } from "vitest";

import { dispatchGetHandshake } from "../src/handshake";

// PR1 of the GET verification-handshake dispatcher: the NO-SECRET protocols only (Dropbox + Adobe I/O
// `?challenge=` bare echo; Adobe Sign `X-AdobeSign-ClientId` header echo). The secret-based protocols
// (Meta verify-token, X CRC HMAC, eBay hash) are PR2/PR3 and MUST fall through to `null` here.

const url = (qs: string) => new URL(`https://wbhk.my/whep_tok${qs}`);
const hdrs = (h: Record<string, string> = {}) => new Headers(h);

describe("dispatchGetHandshake — no-secret protocols (PR1)", () => {
  it("Dropbox / Adobe I/O: echoes ?challenge= bare as text/plain with nosniff (gold vector abc123)", async () => {
    const res = dispatchGetHandshake(url("?challenge=abc123"), hdrs());
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
    const res = dispatchGetHandshake(url("?challenge=%3Cscript%3Ealert(1)%3C%2Fscript%3E"), hdrs());
    expect(res).not.toBeNull();
    expect(res!.headers.get("content-type")).toMatch(/text\/plain/);
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res!.text()).toBe("<script>alert(1)</script>"); // echoed verbatim, but inert
  });

  it("Adobe Sign: echoes the X-AdobeSign-ClientId header back on a 200 (no body)", async () => {
    const res = dispatchGetHandshake(url(""), hdrs({ "X-AdobeSign-ClientId": "client-abc-123" }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get("x-adobesign-clientid")).toBe("client-abc-123");
    expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res!.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res!.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res!.text()).toBe("");
  });

  it("returns null for a non-handshake GET (no challenge param, no adobe header) → falls through to capture", () => {
    expect(dispatchGetHandshake(url(""), hdrs())).toBeNull();
    expect(dispatchGetHandshake(url("?foo=bar"), hdrs())).toBeNull();
  });

  it("returns null for an EMPTY ?challenge= (degenerate, not a real handshake)", () => {
    expect(dispatchGetHandshake(url("?challenge="), hdrs())).toBeNull();
  });

  it("does NOT echo the secret-based protocols' params in PR1 (Meta hub.challenge / X crc_token / eBay challenge_code → null)", () => {
    // hub.challenge is a DISTINCT param from `challenge` — must not be caught by the bare-echo path
    expect(
      dispatchGetHandshake(
        url("?hub.mode=subscribe&hub.challenge=1158201444&hub.verify_token=t"),
        hdrs(),
      ),
    ).toBeNull();
    expect(dispatchGetHandshake(url("?crc_token=9b4507b3"), hdrs())).toBeNull();
    expect(dispatchGetHandshake(url("?challenge_code=71745723"), hdrs())).toBeNull();
  });
});
