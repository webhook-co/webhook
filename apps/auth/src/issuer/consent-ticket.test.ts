import { describe, expect, it } from "vitest";

import {
  consentRequestFromTicket,
  importConsentTicketKey,
  signConsentTicket,
  verifyConsentTicket,
  type ConsentTicketPayload,
} from "./consent-ticket";

// The stateless signed consent ticket (A3c). /authorize signs the authorization state + the consent
// display fields into one tamper-proof, expiring envelope (the provider has no state store); the decision
// POST + Lane E's consent page carry it back verbatim. Modeled on the cursor HMAC codec.

const RAW_KEY = new Uint8Array(32).fill(7);

function basePayload(over: Partial<ConsentTicketPayload> = {}): ConsentTicketPayload {
  return {
    request: {
      responseType: "code",
      clientId: "cli_wbhk",
      redirectUri: "http://127.0.0.1:51763/callback",
      scope: ["events:read", "events:replay"],
      state: "xyz",
      codeChallenge: "abc123",
      codeChallengeMethod: "S256",
      resource: "https://api.webhook.co",
    },
    userId: "user_dana",
    orgId: "org_1",
    orgName: "Dana's projects",
    scopes: ["events:read", "events:replay"],
    audience: "https://api.webhook.co",
    clientName: "webhook CLI",
    origin: { ip: "203.0.113.7", location: "San Francisco, US" },
    flow: "pkce_loopback",
    grantExpiresAt: "2026-09-18T00:00:00.000Z",
    keyTtlSeconds: 86_400,
    csrf: "csrf_nonce_abc",
    exp: 1_000_000,
    ...over,
  };
}

describe("importConsentTicketKey", () => {
  it("rejects a key that is not 32 bytes", () => {
    // Synchronous throw at construction (matches importCursorKey) — fail loud on a misconfigured key.
    expect(() => importConsentTicketKey(new Uint8Array(16))).toThrow(/32 bytes/);
  });
  it("imports a 32-byte key", async () => {
    await expect(importConsentTicketKey(RAW_KEY)).resolves.toBeDefined();
  });
});

describe("signConsentTicket / verifyConsentTicket", () => {
  it("round-trips a payload that has not expired", async () => {
    const key = await importConsentTicketKey(RAW_KEY);
    const payload = basePayload({ exp: 2_000 });
    const ticket = await signConsentTicket(payload, key);
    expect(ticket).toContain(".");
    const verified = await verifyConsentTicket(ticket, key, 1_000);
    expect(verified).toEqual(payload);
  });

  it("returns null once the ticket has expired", async () => {
    const key = await importConsentTicketKey(RAW_KEY);
    const payload = basePayload({ exp: 1_000 });
    const ticket = await signConsentTicket(payload, key);
    // exactly at exp is still valid (returns the real payload); strictly after is dead.
    expect(await verifyConsentTicket(ticket, key, 1_000)).toEqual(payload);
    expect(await verifyConsentTicket(ticket, key, 1_001)).toBeNull();
  });

  it("rejects a tampered payload segment", async () => {
    const key = await importConsentTicketKey(RAW_KEY);
    const ticket = await signConsentTicket(basePayload(), key);
    const [body, mac] = ticket.split(".");
    // flip a character in the payload — the MAC no longer recomputes.
    const tampered = `${body!.slice(0, -1)}${body!.slice(-1) === "A" ? "B" : "A"}.${mac}`;
    expect(await verifyConsentTicket(tampered, key, 0)).toBeNull();
  });

  it("rejects a tampered MAC segment", async () => {
    const key = await importConsentTicketKey(RAW_KEY);
    const ticket = await signConsentTicket(basePayload(), key);
    const [body, mac] = ticket.split(".");
    const tampered = `${body}.${mac!.slice(0, -1)}${mac!.slice(-1) === "A" ? "B" : "A"}`;
    expect(await verifyConsentTicket(tampered, key, 0)).toBeNull();
  });

  it("rejects a ticket signed with a different key", async () => {
    const key = await importConsentTicketKey(RAW_KEY);
    const otherKey = await importConsentTicketKey(new Uint8Array(32).fill(9));
    const ticket = await signConsentTicket(basePayload(), key);
    expect(await verifyConsentTicket(ticket, otherKey, 0)).toBeNull();
  });

  it("rejects a malformed ticket (no dot / not base64url)", async () => {
    const key = await importConsentTicketKey(RAW_KEY);
    expect(await verifyConsentTicket("not-a-ticket", key, 0)).toBeNull();
    expect(await verifyConsentTicket("", key, 0)).toBeNull();
    expect(await verifyConsentTicket("@@@.@@@", key, 0)).toBeNull();
  });
});

describe("consentRequestFromTicket", () => {
  it("maps the ticket to the C↔E ConsentRequest (requestId = the ticket, both durations)", () => {
    const ticket = "the.ticket";
    const req = consentRequestFromTicket(ticket, basePayload());
    expect(req.requestId).toBe(ticket);
    expect(req.csrfToken).toBe("csrf_nonce_abc");
    expect(req.flow).toBe("pkce_loopback");
    expect(req.client).toEqual({ id: "cli_wbhk", name: "webhook CLI" });
    expect(req.org).toEqual({ id: "org_1", name: "Dana's projects" });
    expect(req.origin).toEqual({ ip: "203.0.113.7", location: "San Francisco, US" });
    expect(req.scopes).toEqual(["events:read", "events:replay"]);
    expect(req.audience).toBe("https://api.webhook.co");
    expect(req.grantExpiresAt).toBe("2026-09-18T00:00:00.000Z");
    expect(req.keyTtlSeconds).toBe(86_400);
    expect(req.device).toBeUndefined();
  });

  it("carries the device for a device-code flow", () => {
    const req = consentRequestFromTicket(
      "t.t",
      basePayload({ flow: "device_code", device: { name: "Dana's laptop" } }),
    );
    expect(req.device).toEqual({ name: "Dana's laptop" });
  });
});
