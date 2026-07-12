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

describe("listen-ticket codec — optional userId (S.8, deploy-compatible)", () => {
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

  it("still verifies an older USERLESS ticket — no version bump, so a rolling deploy never 401s", async () => {
    // A ticket minted by an older web deploy (no `u`). It MUST verify — a hard version bump would break every
    // live-events session in the window where engine and web are on different versions. Engine sees no userId
    // and falls back to the lifetime cap.
    const key = await keyA();
    const token = await mintListenTicket(key, { orgId: ORG, endpointId: ENDPOINT }, NOW);
    const grant = await verifyListenTicket(key, token, NOW);
    expect(grant).toEqual({ orgId: ORG, endpointId: ENDPOINT });
    expect(grant).not.toHaveProperty("userId");
  });

  it("drops an empty userId at mint, so it can never emit a trust-later empty-string user", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { orgId: ORG, endpointId: ENDPOINT, userId: "" },
      NOW,
    );
    expect(await verifyListenTicket(key, token, NOW)).toEqual({ orgId: ORG, endpointId: ENDPOINT });
  });

  it("rejects a hand-forged ticket whose `u` is an empty string on the wire", async () => {
    const key = await keyA();
    const envelope = { v: LISTEN_TICKET_VERSION, o: ORG, e: ENDPOINT, u: "", exp: NOW + 60 };
    const bytes = utf8Encoder.encode(JSON.stringify(envelope));
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, bytes as Uint8Array<ArrayBuffer>),
    ).slice(0, 16);
    const forged = `${bytesToB64url(bytes)}.${bytesToB64url(sig)}`;
    expect(await verifyListenTicket(key, forged, NOW)).toBeNull();
  });
});
