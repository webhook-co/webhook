import { beforeAll, describe, expect, it } from "vitest";

import { signLoopbackTicket, verifyLoopbackTicket } from "./completion-ticket";
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
