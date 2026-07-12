import { describe, expect, it } from "vitest";

import { bytesToB64url, utf8Encoder } from "./bytes";
import {
  importListenTicketKey,
  LISTEN_TICKET_TTL_SECONDS,
  LISTEN_TICKET_VERSION,
  mintListenTicket,
  verifyListenTicket,
} from "./listen-ticket";

const KEY_A = new Uint8Array(32).fill(7);
const KEY_B = new Uint8Array(32).fill(9);
const ORG = "11111111-1111-1111-1111-111111111111";
const ENDPOINT = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const NOW = 1_800_000_000;

async function keyA() {
  return importListenTicketKey(KEY_A);
}

describe("listen-ticket codec", () => {
  it("round-trips org + endpoint within the TTL", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    const out = await verifyListenTicket(key, token, NOW + LISTEN_TICKET_TTL_SECONDS - 1);
    expect(out).toEqual({ orgId: ORG, endpointId: ENDPOINT, userId: USER });
  });

  it("accepts a ticket exactly at expiry and rejects one past it", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    expect(await verifyListenTicket(key, token, NOW + LISTEN_TICKET_TTL_SECONDS)).not.toBeNull();
    expect(await verifyListenTicket(key, token, NOW + LISTEN_TICKET_TTL_SECONDS + 1)).toBeNull();
  });

  it("rejects a ticket signed with a different key (no forgery without the key)", async () => {
    const token = await mintListenTicket(
      await keyA(),
      { orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    const other = await importListenTicketKey(KEY_B);
    expect(await verifyListenTicket(other, token, NOW)).toBeNull();
  });

  it("rejects a tampered payload (MAC no longer recomputes)", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    // Re-sign a swapped-org payload with the ORIGINAL mac → the MAC check must fail.
    const [, mac] = token.split(".");
    const forgedPayload = bytesToB64url(
      utf8Encoder.encode(
        JSON.stringify({ v: LISTEN_TICKET_VERSION, o: "attacker-org", e: ENDPOINT, exp: NOW + 60 }),
      ),
    );
    expect(await verifyListenTicket(key, `${forgedPayload}.${mac}`, NOW)).toBeNull();
  });

  it("rejects a wrong-version envelope (clean break)", async () => {
    const key = await keyA();
    // Hand-sign a v99 envelope with the real key — the MAC is valid but the version gate rejects it.
    const bytes = utf8Encoder.encode(JSON.stringify({ v: 99, o: ORG, e: ENDPOINT, exp: NOW + 60 }));
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, bytes as Uint8Array<ArrayBuffer>),
    ).slice(0, 16);
    const token = `${bytesToB64url(bytes)}.${bytesToB64url(sig)}`;
    expect(await verifyListenTicket(key, token, NOW)).toBeNull();
  });

  it("returns null for malformed tokens, never throwing", async () => {
    const key = await keyA();
    for (const bad of ["", ".", "abc", "no-dot", ".onlymac", "onlybytes.", "@@@.@@@"]) {
      expect(await verifyListenTicket(key, bad, NOW)).toBeNull();
    }
  });

  it("rejects a key that is not 32 bytes, loudly", async () => {
    await expect(importListenTicketKey(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});

describe("listen-ticket codec — userId (S.8)", () => {
  // The ticket must carry WHICH USER it was minted for, so the engine's live-events socket can periodically
  // re-check that user is still a member of the org (a removed member's open tab used to stream event
  // metadata for the socket's whole lifetime). Before v2 the envelope was {o, e, exp} only.
  it("round-trips the userId", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    expect(await verifyListenTicket(key, token, NOW)).toEqual({
      orgId: ORG,
      endpointId: ENDPOINT,
      userId: USER,
    });
  });

  it("rejects a v1 (userless) ticket — a clean break, so it can never verify without a user", async () => {
    // Hand-forge the OLD envelope shape and sign it with the real key: it must fail on the version check,
    // because a socket authorized without a userId can never be membership-re-checked.
    const key = await keyA();
    const oldEnvelope = { v: 1, o: ORG, e: ENDPOINT, exp: NOW + 60 };
    const bytes = utf8Encoder.encode(JSON.stringify(oldEnvelope));
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, bytes as Uint8Array<ArrayBuffer>),
    ).slice(0, 16);
    const forged = `${bytesToB64url(bytes)}.${bytesToB64url(sig)}`;
    expect(await verifyListenTicket(key, forged, NOW)).toBeNull();
  });

  it("rejects a ticket with an empty or missing userId", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { orgId: ORG, endpointId: ENDPOINT, userId: "" },
      NOW,
    );
    expect(await verifyListenTicket(key, token, NOW)).toBeNull();
  });

  it("bumped the version to 2", () => {
    expect(LISTEN_TICKET_VERSION).toBe(2);
  });
});
