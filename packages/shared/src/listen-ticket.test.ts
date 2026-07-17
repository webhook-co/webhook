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

/** Hand-sign an arbitrary envelope with the REAL key — the MAC is valid, so only the envelope-shape gates
 *  can reject it. This is how we probe "a forged-but-signed ticket with the wrong shape fails closed". */
async function handSign(key: CryptoKey, envelope: unknown): Promise<string> {
  const bytes = utf8Encoder.encode(JSON.stringify(envelope));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, bytes as Uint8Array<ArrayBuffer>),
  ).slice(0, 16);
  return `${bytesToB64url(bytes)}.${bytesToB64url(sig)}`;
}

describe("listen-ticket codec", () => {
  it("round-trips an endpoint-scoped grant within the TTL", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { scope: "endpoint", orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    const out = await verifyListenTicket(key, token, NOW + LISTEN_TICKET_TTL_SECONDS - 1);
    expect(out).toEqual({ scope: "endpoint", orgId: ORG, endpointId: ENDPOINT, userId: USER });
  });

  it("accepts a ticket exactly at expiry and rejects one past it", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { scope: "endpoint", orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    expect(await verifyListenTicket(key, token, NOW + LISTEN_TICKET_TTL_SECONDS)).not.toBeNull();
    expect(await verifyListenTicket(key, token, NOW + LISTEN_TICKET_TTL_SECONDS + 1)).toBeNull();
  });

  it("rejects a ticket signed with a different key (no forgery without the key)", async () => {
    const token = await mintListenTicket(
      await keyA(),
      { scope: "endpoint", orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    const other = await importListenTicketKey(KEY_B);
    expect(await verifyListenTicket(other, token, NOW)).toBeNull();
  });

  it("rejects a tampered payload (MAC no longer recomputes)", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { scope: "endpoint", orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    // Re-sign a swapped-org payload with the ORIGINAL mac → the MAC check must fail.
    const [, mac] = token.split(".");
    const forgedPayload = bytesToB64url(
      utf8Encoder.encode(
        JSON.stringify({
          v: LISTEN_TICKET_VERSION,
          o: "attacker-org",
          s: "endpoint",
          e: ENDPOINT,
          exp: NOW + 60,
        }),
      ),
    );
    expect(await verifyListenTicket(key, `${forgedPayload}.${mac}`, NOW)).toBeNull();
  });

  it("rejects a wrong-version envelope (clean break — a v1 ticket no longer verifies)", async () => {
    const key = await keyA();
    // Hand-sign the OLD v1 envelope with the real key — the MAC is valid but the version gate rejects it.
    const token = await handSign(key, { v: 1, o: ORG, e: ENDPOINT, exp: NOW + 60 });
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

// The scope discriminator (slice 9): a ticket grants EITHER one endpoint OR the whole org. The invariant that
// makes this safe is "absence never grants" — every ticket must NAME its scope, and scope + endpoint must
// agree. A malformed, truncated, or old-shape envelope resolves to null, never to the broader org grant.
describe("listen-ticket codec — org/endpoint scope discriminator", () => {
  it("round-trips an ORG-scoped grant (no endpoint)", async () => {
    const key = await keyA();
    const token = await mintListenTicket(key, { scope: "org", orgId: ORG, userId: USER }, NOW);
    expect(await verifyListenTicket(key, token, NOW)).toEqual({
      scope: "org",
      orgId: ORG,
      userId: USER,
    });
  });

  it("an org-scoped grant carries NO endpoint on the wire", async () => {
    const key = await keyA();
    const token = await mintListenTicket(key, { scope: "org", orgId: ORG, userId: USER }, NOW);
    const grant = await verifyListenTicket(key, token, NOW);
    expect(grant).not.toHaveProperty("endpointId");
  });

  it("REJECTS an org-scoped ticket that also carries an endpoint (scope and endpoint must agree)", async () => {
    // A signed s:"org" envelope with a stray `e` is contradictory — fail closed rather than guess which wins.
    const key = await keyA();
    const token = await handSign(key, {
      v: LISTEN_TICKET_VERSION,
      o: ORG,
      s: "org",
      e: ENDPOINT,
      exp: NOW + 60,
    });
    expect(await verifyListenTicket(key, token, NOW)).toBeNull();
  });

  it("REJECTS an endpoint-scoped ticket with no endpoint on the wire", async () => {
    const key = await keyA();
    const token = await handSign(key, {
      v: LISTEN_TICKET_VERSION,
      o: ORG,
      s: "endpoint",
      exp: NOW + 60,
    });
    expect(await verifyListenTicket(key, token, NOW)).toBeNull();
  });

  it("REJECTS an unknown scope value", async () => {
    const key = await keyA();
    const token = await handSign(key, {
      v: LISTEN_TICKET_VERSION,
      o: ORG,
      s: "team",
      e: ENDPOINT,
      exp: NOW + 60,
    });
    expect(await verifyListenTicket(key, token, NOW)).toBeNull();
  });

  it("REJECTS an envelope with NO scope field — absence never grants", async () => {
    // The core of the safety argument: an old-shape or truncated envelope missing `s` resolves to null. It can
    // never silently degrade to EITHER scope, and least of all to the broader org grant.
    const key = await keyA();
    const token = await handSign(key, {
      v: LISTEN_TICKET_VERSION,
      o: ORG,
      e: ENDPOINT,
      exp: NOW + 60,
    });
    expect(await verifyListenTicket(key, token, NOW)).toBeNull();
  });
});

describe("listen-ticket codec — optional userId (deploy-compatible within a version)", () => {
  // The ticket carries WHICH USER it was minted for, so the engine's live-events socket can periodically
  // re-check that user is still a member of the org (a removed member's open tab used to stream event
  // metadata for the socket's whole lifetime). `u` is optional WITHIN a version: a mint that omits it verifies
  // fine and the engine falls back to the lifetime cap (no membership re-check).
  it("round-trips the userId (endpoint scope)", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { scope: "endpoint", orgId: ORG, endpointId: ENDPOINT, userId: USER },
      NOW,
    );
    expect(await verifyListenTicket(key, token, NOW)).toEqual({
      scope: "endpoint",
      orgId: ORG,
      endpointId: ENDPOINT,
      userId: USER,
    });
  });

  it("verifies a USERLESS ticket — the engine falls back to the lifetime cap", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { scope: "endpoint", orgId: ORG, endpointId: ENDPOINT },
      NOW,
    );
    const grant = await verifyListenTicket(key, token, NOW);
    expect(grant).toEqual({ scope: "endpoint", orgId: ORG, endpointId: ENDPOINT });
    expect(grant).not.toHaveProperty("userId");
  });

  it("drops an empty userId at mint, so it can never emit a trust-later empty-string user", async () => {
    const key = await keyA();
    const token = await mintListenTicket(
      key,
      { scope: "endpoint", orgId: ORG, endpointId: ENDPOINT, userId: "" },
      NOW,
    );
    expect(await verifyListenTicket(key, token, NOW)).toEqual({
      scope: "endpoint",
      orgId: ORG,
      endpointId: ENDPOINT,
    });
  });

  it("rejects a hand-forged ticket whose `u` is an empty string on the wire", async () => {
    const key = await keyA();
    const forged = await handSign(key, {
      v: LISTEN_TICKET_VERSION,
      o: ORG,
      s: "endpoint",
      e: ENDPOINT,
      u: "",
      exp: NOW + 60,
    });
    expect(await verifyListenTicket(key, forged, NOW)).toBeNull();
  });
});
