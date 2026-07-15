import { describe, expect, it } from "vitest";

import {
  avatarR2Key,
  endpointPrefix,
  isWellFormedAvatarKey,
  isWellFormedOrgLogoKey,
  isWellFormedPayloadKey,
  orgLogoR2Key,
  payloadR2Key,
  readPayloadKey,
} from "./r2";

const org = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const ep = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

// Two distinct 32-byte content digests (stand-ins for sha256(body)).
const bodyA = new Uint8Array(32).fill(0xa1);
const bodyB = new Uint8Array(32).fill(0xb2);

describe("R2 key model", () => {
  it("is deterministic in (endpoint_id, dedup_key, content_hash) — a genuine retry maps to the same key", async () => {
    const a = await payloadR2Key(org, ep, "dedup-1", bodyA);
    const b = await payloadR2Key(org, ep, "dedup-1", bodyA);
    expect(a).toBe(b);
  });

  it("distinct dedup keys map to distinct objects", async () => {
    const a = await payloadR2Key(org, ep, "dedup-1", bodyA);
    const b = await payloadR2Key(org, ep, "dedup-2", bodyA);
    expect(a).not.toBe(b);
  });

  it("SAME dedup key but DIFFERENT body maps to a DIFFERENT object (forged-overwrite defense)", async () => {
    // A forged request that re-derives an existing dedup key but carries a different payload must
    // NOT land on the same R2 object — otherwise it could overwrite the legit event's body.
    const legit = await payloadR2Key(org, ep, "dedup-1", bodyA);
    const forged = await payloadR2Key(org, ep, "dedup-1", bodyB);
    expect(forged).not.toBe(legit);
  });

  it("lives under the endpoint prefix and ends in a 64-char sha256 hex", async () => {
    const key = await payloadR2Key(org, ep, "dedup-1", bodyA);
    expect(key.startsWith(endpointPrefix(org, ep))).toBe(true);
    expect(key.slice(endpointPrefix(org, ep).length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not collide across the (endpoint,dedup) split boundary", async () => {
    const a = await payloadR2Key(org, `${ep}x`, "y", bodyA);
    const b = await payloadR2Key(org, ep, `xy`, bodyA);
    expect(a).not.toBe(b);
  });
});

describe("readPayloadKey — stored-key read fence", () => {
  const key = `${endpointPrefix(org, ep)}${"a".repeat(64)}`;

  it("returns a well-formed key under the endpoint's own prefix", () => {
    expect(readPayloadKey(org, ep, key)).toBe(key);
  });

  it("rejects a key under a DIFFERENT endpoint / org prefix (cross-tenant fence)", () => {
    const otherEp = `${endpointPrefix(org, "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5099")}${"a".repeat(64)}`;
    const otherOrg = `${endpointPrefix("0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f50ff", ep)}${"a".repeat(64)}`;
    expect(readPayloadKey(org, ep, otherEp)).toBeNull();
    expect(readPayloadKey(org, ep, otherOrg)).toBeNull();
  });

  it("rejects a malformed object-name suffix (traversal / wrong shape)", () => {
    expect(readPayloadKey(org, ep, `${endpointPrefix(org, ep)}../../etc/passwd`)).toBeNull();
    expect(readPayloadKey(org, ep, `${endpointPrefix(org, ep)}${"a".repeat(63)}`)).toBeNull();
    expect(readPayloadKey(org, ep, `${endpointPrefix(org, ep)}${"A".repeat(64)}`)).toBeNull();
  });

  it("FAILS CLOSED on a non-string value (rolling-deploy skew: a caller omitted payloadR2Key)", () => {
    // A previous-release caller can send { dedupKey } with no payloadR2Key; the field arrives
    // undefined over the RPC. This MUST return null (→ retryable failed), never throw.
    expect(readPayloadKey(org, ep, undefined as unknown as string)).toBeNull();
    expect(readPayloadKey(org, ep, null as unknown as string)).toBeNull();
    expect(readPayloadKey(org, ep, 42 as unknown as string)).toBeNull();
  });
});

describe("isWellFormedPayloadKey — the orphan-sweep prefix fence (S6c-iii)", () => {
  const good = `${endpointPrefix(org, ep)}${"a".repeat(64)}`;

  it("accepts an exact org/{uuid}/ep/{uuid}/{sha256hex} key", () => {
    expect(isWellFormedPayloadKey(good)).toBe(true);
  });

  it("REJECTS anything not exactly that shape (never delete a foreign/malformed object)", () => {
    expect(isWellFormedPayloadKey("some/other/thing")).toBe(false);
    expect(isWellFormedPayloadKey(`org/not-a-uuid/ep/${ep}/${"a".repeat(64)}`)).toBe(false);
    expect(isWellFormedPayloadKey(`${endpointPrefix(org, ep)}${"a".repeat(63)}`)).toBe(false); // short hash
    expect(isWellFormedPayloadKey(`${endpointPrefix(org, ep)}${"A".repeat(64)}`)).toBe(false); // upper hex
    expect(isWellFormedPayloadKey(`${good}/extra`)).toBe(false); // trailing segment
    expect(isWellFormedPayloadKey(`prefix/${good}`)).toBe(false); // leading segment
    expect(isWellFormedPayloadKey(undefined as unknown as string)).toBe(false);
  });
});

describe("avatarR2Key + isWellFormedAvatarKey", () => {
  it("builds the deterministic per-user key", () => {
    expect(avatarR2Key("user_abc-123")).toBe("user/user_abc-123/avatar.webp");
  });

  it("accepts exactly the avatar shape and rejects anything else (orphan-sweep fence)", () => {
    expect(isWellFormedAvatarKey("user/user_abc-123/avatar.webp")).toBe(true);
    expect(isWellFormedAvatarKey("user//avatar.webp")).toBe(false); // empty id
    expect(isWellFormedAvatarKey("user/x/avatar.png")).toBe(false); // wrong ext
    expect(isWellFormedAvatarKey("user/a/b/avatar.webp")).toBe(false); // extra segment
    expect(isWellFormedAvatarKey("org/x/avatar.webp")).toBe(false); // wrong prefix
    expect(isWellFormedAvatarKey("user/a b/avatar.webp")).toBe(false); // illegal char
  });
});

describe("orgLogoR2Key + isWellFormedOrgLogoKey", () => {
  const UUID = "9b5ac09c-b60c-4998-9b95-51dd53dec8da";

  it("builds the deterministic per-org key", () => {
    expect(orgLogoR2Key(UUID)).toBe(`org/${UUID}/logo.webp`);
  });

  it("accepts exactly the org-logo shape (UUID-strict) and rejects anything else", () => {
    expect(isWellFormedOrgLogoKey(`org/${UUID}/logo.webp`)).toBe(true);
    // UUID-strict: the org id is a real uuid column, so the fence is stricter than the avatar's.
    expect(isWellFormedOrgLogoKey("org/not-a-uuid/logo.webp")).toBe(false);
    expect(isWellFormedOrgLogoKey(`org/${UUID}/logo.png`)).toBe(false); // wrong ext
    expect(isWellFormedOrgLogoKey(`org/${UUID}/avatar.webp`)).toBe(false); // wrong leaf
    expect(isWellFormedOrgLogoKey(`user/${UUID}/logo.webp`)).toBe(false); // wrong prefix
    expect(isWellFormedOrgLogoKey(`org/${UUID}/x/logo.webp`)).toBe(false); // extra segment
    // Must never collide with the payload prefix (also org/{uuid}/…).
    expect(isWellFormedOrgLogoKey(`org/${UUID}/ep/${UUID}/${"a".repeat(64)}`)).toBe(false);
  });
});
