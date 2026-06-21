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
    origin: { ip: "203.0.113.7", location: "San Francisco, US" },
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
  } as ConsentTicketPayload;
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
    expect(request?.org.name).toBe("Acme Inc");
    expect(request?.scopes).toEqual(["events:read"]);
    expect(request?.keyTtlSeconds).toBe(86_400);
  });

  it("returns null for a missing ticket", async () => {
    expect(await resolveConsentRequest(null)).toBeNull();
    expect(await resolveConsentRequest("")).toBeNull();
  });

  it("returns null for a tampered ticket", async () => {
    const ticket = await makeTicket();
    const tampered = `${ticket.slice(0, -2)}AA`;
    expect(await resolveConsentRequest(tampered)).toBeNull();
  });

  it("returns null for an expired ticket", async () => {
    const ticket = await makeTicket({ exp: nowSeconds() - 10 });
    expect(await resolveConsentRequest(ticket)).toBeNull();
  });
});
