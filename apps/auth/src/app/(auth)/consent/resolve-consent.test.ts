import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCloudflareContext } = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import {
  importConsentTicketKey,
  signConsentTicket,
  type ConsentTicketPayload,
} from "@/issuer/consent-ticket";

import { resolveConsentRequest } from "./resolve-consent";

// A 32-byte key, as the standard base64 the CONSENT_TICKET_KEY secret holds.
const secretBytes = new Uint8Array(32).fill(7);
const secretB64 = Buffer.from(secretBytes).toString("base64");

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function payload(over: Partial<ConsentTicketPayload> = {}): ConsentTicketPayload {
  return {
    flow: "pkce_loopback",
    userId: "usr_dana",
    orgId: "org_acme",
    orgName: "Acme Inc",
    scopes: ["events:read"],
    audience: "https://api.webhook.co",
    clientId: "cli_wbhk",
    clientName: "webhook CLI",
    clientIdentityDomain: null,
    clientVerified: false,
    redirectHost: "127.0.0.1",
    redirectIsLoopback: true,
    origin: {
      ip: "203.0.113.7",
      location: "US",
      city: "San Francisco",
      region: "California",
      regionCode: "CA",
    },
    grantExpiresAt: "2026-09-18T00:00:00Z",
    keyTtlSeconds: 86_400,
    csrf: "csrf_nonce",
    exp: nowSeconds() + 600,
    request: {
      responseType: "code",
      clientId: "cli_wbhk",
      redirectUri: "http://127.0.0.1:9999/cb",
      scope: ["events:read"],
      state: "st",
    },
    ...over,
  };
}

async function makeTicket(over?: Partial<ConsentTicketPayload>): Promise<string> {
  const key = await importConsentTicketKey(secretBytes);
  return signConsentTicket(payload(over), key);
}

describe("resolveConsentRequest", () => {
  beforeEach(() => {
    // CONSENT_TICKET_KEY is a plain string (dev) so readSecretBinding returns it verbatim.
    getCloudflareContext.mockResolvedValue({ env: { CONSENT_TICKET_KEY: secretB64 } });
  });

  it("verifies a valid ticket and projects it to the ConsentRequest", async () => {
    const ticket = await makeTicket();
    const request = await resolveConsentRequest(ticket);
    expect(request).not.toBeNull();
    expect(request?.requestId).toBe(ticket); // the ticket IS the requestId
    expect(request?.csrfToken).toBe("csrf_nonce");
    expect(request?.client.name).toBe("webhook CLI");
    // the anti-phishing provenance survives the seal→verify→project round-trip
    expect(request?.client.identityDomain).toBeNull();
    expect(request?.client.verified).toBe(false);
    expect(request?.redirect).toEqual({ host: "127.0.0.1", isLoopback: true });
    expect(request?.org.name).toBe("Acme Inc");
    expect(request?.scopes).toEqual(["events:read"]);
    expect(request?.keyTtlSeconds).toBe(86_400);
    // the best-effort geo (2-letter country + city/region) survives the seal→verify→project round-trip
    expect(request?.origin).toEqual({
      ip: "203.0.113.7",
      location: "US",
      city: "San Francisco",
      region: "California",
      regionCode: "CA",
    });
  });

  it("returns null for a missing ticket", async () => {
    expect(await resolveConsentRequest(null)).toBeNull();
    expect(await resolveConsentRequest("")).toBeNull();
  });

  it("returns null for a tampered ticket", async () => {
    const ticket = await makeTicket();

    // Tamper in the MIDDLE of the MAC, never at its END.
    //
    // The ticket is `<base64url(json)>.<base64url(mac)>` and the MAC is HMAC-SHA256 — 32 bytes = 256
    // bits, which base64url-encodes to 43 chars. 43 * 6 = 258, so the FINAL character carries only 4
    // significant bits; its low 2 bits are padding and are DISCARDED on decode. Mutating the last
    // char therefore often decodes to the IDENTICAL MAC and tampers nothing, so the "tampered" ticket
    // verifies fine and the assertion below fails.
    //
    // Measured over 20k random tags: overwriting the last two chars with "AA" (the original form) was
    // a no-op 0.1% of the time; flipping just the last char is a no-op 6.3% of the time. Flipping a
    // middle char — which carries all 6 of its bits — is a no-op 0.0% of the time.
    const dot = ticket.lastIndexOf(".");
    const mac = ticket.slice(dot + 1);
    const i = Math.floor(mac.length / 2);
    const tamperedMac = mac.slice(0, i) + (mac[i] === "A" ? "B" : "A") + mac.slice(i + 1);
    const tampered = `${ticket.slice(0, dot + 1)}${tamperedMac}`;

    expect(tampered).not.toBe(ticket); // the tamper must actually change the string...
    expect(tamperedMac).not.toBe(mac); // ...and specifically the MAC
    expect(await resolveConsentRequest(tampered)).toBeNull();
  });

  it("returns null for an expired ticket", async () => {
    const ticket = await makeTicket({ exp: nowSeconds() - 10 });
    expect(await resolveConsentRequest(ticket)).toBeNull();
  });
});
