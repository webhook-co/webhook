import { describe, expect, it } from "vitest";

import { endpointPrefix, payloadR2Key } from "./r2";

const org = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5060";
const ep = "0190a1b2-c3d4-7e5f-8a0b-1c2d3e4f5061";

describe("R2 key model", () => {
  it("is deterministic in (endpoint_id, dedup_key) — a retry maps to the same key", async () => {
    const a = await payloadR2Key(org, ep, "dedup-1");
    const b = await payloadR2Key(org, ep, "dedup-1");
    expect(a).toBe(b);
  });

  it("distinct dedup keys map to distinct objects", async () => {
    const a = await payloadR2Key(org, ep, "dedup-1");
    const b = await payloadR2Key(org, ep, "dedup-2");
    expect(a).not.toBe(b);
  });

  it("lives under the endpoint prefix and ends in a 64-char sha256 hex", async () => {
    const key = await payloadR2Key(org, ep, "dedup-1");
    expect(key.startsWith(endpointPrefix(org, ep))).toBe(true);
    expect(key.slice(endpointPrefix(org, ep).length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not collide across the (endpoint,dedup) split boundary", async () => {
    const a = await payloadR2Key(org, `${ep}x`, "y");
    const b = await payloadR2Key(org, ep, `xy`);
    expect(a).not.toBe(b);
  });
});
