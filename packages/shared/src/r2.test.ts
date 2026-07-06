import { describe, expect, it } from "vitest";

import { endpointPrefix, payloadR2Key } from "./r2";

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
