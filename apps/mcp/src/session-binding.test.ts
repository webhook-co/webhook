import type { AuthContext } from "@webhook-co/contract";
import { describe, expect, it } from "vitest";

import {
  bindSessionId,
  importSessionKey,
  principalDigest,
  unbindSessionId,
} from "./session-binding";

// A8c — the per-request principal-isolation primitive. mcp's MCP session id (server-assigned by the
// McpAgent transport, which routes the Durable Object purely by it) is wrapped in an HMAC-signed envelope
// binding it to the INITIALIZING principal; every later request must present the matching principal or the
// session is rejected — so a stolen/reused session id can't be used by a DIFFERENT principal to reach the
// first principal's DO. Pure crypto (Web Crypto + base64url), unit-tested with no DO.

const KEY_BYTES = new Uint8Array(32).fill(7);
const OTHER_KEY_BYTES = new Uint8Array(32).fill(9);

const ALICE: AuthContext = { orgId: "org_alice", userId: "usr_a", scopes: ["events:read"] };
const ALICE_AGAIN: AuthContext = { orgId: "org_alice", userId: "usr_a", scopes: ["audit:read"] };
const BOB: AuthContext = { orgId: "org_bob", userId: "usr_b", scopes: ["events:read"] };
const ALICE_ORGKEY: AuthContext = { orgId: "org_alice", scopes: ["events:read"] }; // no userId

async function key() {
  return importSessionKey(KEY_BYTES);
}

describe("importSessionKey", () => {
  it("rejects a key that isn't 32 bytes", async () => {
    await expect(importSessionKey(new Uint8Array(16))).rejects.toThrow(/32/);
  });
});

describe("principalDigest", () => {
  it("is stable for the same principal across requests (scopes don't affect it)", async () => {
    expect(await principalDigest(ALICE)).toBe(await principalDigest(ALICE_AGAIN));
  });

  it("differs across orgs", async () => {
    expect(await principalDigest(ALICE)).not.toBe(await principalDigest(BOB));
  });

  it("differs for the same org with vs without a user (an org key is a distinct principal)", async () => {
    expect(await principalDigest(ALICE)).not.toBe(await principalDigest(ALICE_ORGKEY));
  });
});

describe("bind / unbind session id", () => {
  it("round-trips: the same principal recovers the base session id", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const wrapped = await bindSessionId(k, "base-session-123", pd);
    expect(wrapped).not.toBe("base-session-123"); // it's wrapped, not the raw id
    expect(await unbindSessionId(k, wrapped, pd)).toBe("base-session-123");
  });

  it("is deterministic (same base + principal → same wrapped id, so the client keeps one stable id)", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    expect(await bindSessionId(k, "G", pd)).toBe(await bindSessionId(k, "G", pd));
  });

  it("REJECTS a different principal reusing the wrapped id (cross-principal isolation)", async () => {
    const k = await key();
    const wrapped = await bindSessionId(k, "alices-session", await principalDigest(ALICE));
    // Bob presents Alice's wrapped session id with his own principal → no base id, no DO access.
    expect(await unbindSessionId(k, wrapped, await principalDigest(BOB))).toBeNull();
  });

  it("rejects a tampered envelope", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    const wrapped = await bindSessionId(k, "base", pd);
    const tampered = `${wrapped.slice(0, -2)}xx`;
    expect(await unbindSessionId(k, tampered, pd)).toBeNull();
  });

  it("rejects an envelope signed with a different key (no forgery)", async () => {
    const pd = await principalDigest(ALICE);
    const wrapped = await bindSessionId(await importSessionKey(OTHER_KEY_BYTES), "base", pd);
    expect(await unbindSessionId(await key(), wrapped, pd)).toBeNull();
  });

  it("rejects a forged `baseId.principalDigest` plaintext (a signature is required)", async () => {
    // An attacker who knows a base id + their own digest can't craft a valid wrapped id without the key.
    const k = await key();
    const forged = `${btoa("base")}.${await principalDigest(BOB)}`;
    expect(await unbindSessionId(k, forged, await principalDigest(BOB))).toBeNull();
  });

  it("returns null on a malformed (no-dot / empty) id rather than throwing", async () => {
    const k = await key();
    const pd = await principalDigest(ALICE);
    expect(await unbindSessionId(k, "nodothere", pd)).toBeNull();
    expect(await unbindSessionId(k, "", pd)).toBeNull();
  });
});
