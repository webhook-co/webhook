import { beforeAll, describe, expect, it } from "vitest";

import {
  makeCompletionBounce,
  signLoopbackTicket,
  verifyLoopbackTicket,
} from "./completion-ticket";
import { importConsentTicketKey } from "./consent-ticket";

// The loopback-completion ticket seals the server-computed loopback redirect URL so GET /consent/complete
// can 302 to it without becoming an open redirector. It reuses the consent-ticket HMAC codec + key; these
// pin the MAC integrity, the inclusive expiry, and the malformed/wrong-key fail-closed behavior.

const LOOPBACK = "http://127.0.0.1:51763/callback?code=AC&state=st_123";
let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  key = await importConsentTicketKey(new Uint8Array(32).fill(7));
  otherKey = await importConsentTicketKey(new Uint8Array(32).fill(9));
});

describe("loopback completion ticket", () => {
  it("round-trips the sealed redirect URL", async () => {
    const ticket = await signLoopbackTicket(LOOPBACK, key, 1000);
    expect(await verifyLoopbackTicket(ticket, key, 999)).toBe(LOOPBACK);
  });

  it("is valid through exp (inclusive) and dead strictly after", async () => {
    const ticket = await signLoopbackTicket(LOOPBACK, key, 1000);
    expect(await verifyLoopbackTicket(ticket, key, 1000)).toBe(LOOPBACK);
    expect(await verifyLoopbackTicket(ticket, key, 1001)).toBeNull();
  });

  it("rejects a tampered ticket (MAC mismatch)", async () => {
    const ticket = await signLoopbackTicket(LOOPBACK, key, 1000);
    const tampered = ticket.slice(0, -3) + (ticket.endsWith("AAA") ? "BBB" : "AAA");
    expect(await verifyLoopbackTicket(tampered, key, 999)).toBeNull();
  });

  it("rejects a ticket signed with a different key", async () => {
    const ticket = await signLoopbackTicket(LOOPBACK, key, 1000);
    expect(await verifyLoopbackTicket(ticket, otherKey, 999)).toBeNull();
  });

  it("rejects a malformed ticket (no separator / bad base64url)", async () => {
    expect(await verifyLoopbackTicket("no-dot-here", key, 999)).toBeNull();
    expect(await verifyLoopbackTicket(".", key, 999)).toBeNull();
    expect(await verifyLoopbackTicket("@@@.@@@", key, 999)).toBeNull();
  });
});

const BOUNCE_PREFIX = "/consent/complete?c=";

describe("makeCompletionBounce (the real seal/open closures behind the /consent/complete server-302)", () => {
  const now = () => 1000;

  it("seals a loopback redirect into a same-origin bounce and opens it back", async () => {
    const bounce = makeCompletionBounce(key, now, 120);
    const sealed = await bounce.seal(LOOPBACK);
    expect(sealed.startsWith(BOUNCE_PREFIX)).toBe(true);
    const ticket = decodeURIComponent(sealed.slice(BOUNCE_PREFIX.length));
    expect(await bounce.open(ticket)).toBe(LOOPBACK);
  });

  it("opens a signed http-loopback ticket for every loopback host spelling", async () => {
    const bounce = makeCompletionBounce(key, now, 120);
    for (const url of [
      "http://127.0.0.1:5000/cb?code=AC",
      "http://[::1]:5000/cb?code=AC",
      "http://localhost:33333/callback?code=AC",
    ]) {
      const ticket = await signLoopbackTicket(url, key, now() + 120);
      expect(await bounce.open(ticket)).toBe(url);
    }
  });

  it("REFUSES to open a ticket whose target is https — even an allowlisted vendor host", async () => {
    // The server 302 must ONLY ever target an http loopback (Private Network Access is why the bounce
    // exists). This locks that `open` uses the NARROW isHttpLoopbackRedirect, not isRegisterableRedirectUri:
    // if it were widened, this would 302 to claude.ai — an own-origin open redirector leaking the code.
    const bounce = makeCompletionBounce(key, now, 120);
    const allowlistedHttps = await signLoopbackTicket(
      "https://claude.ai/api/mcp/auth_callback?code=AC",
      key,
      now() + 120,
    );
    expect(await bounce.open(allowlistedHttps)).toBeNull();
    const remoteHttp = await signLoopbackTicket("http://evil.com/cb?code=AC", key, now() + 120);
    expect(await bounce.open(remoteHttp)).toBeNull();
  });

  it("fails closed (null) on an expired or wrong-key ticket", async () => {
    const bounce = makeCompletionBounce(key, () => 2000, 120);
    const expired = await signLoopbackTicket(LOOPBACK, key, 1500); // exp 1500 < now 2000
    expect(await bounce.open(expired)).toBeNull();
    const forged = await signLoopbackTicket(LOOPBACK, otherKey, 3000);
    expect(await bounce.open(forged)).toBeNull();
  });
});
