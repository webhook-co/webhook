import { describe, expect, it } from "vitest";

import { openInvitePayload, sealInvitePayload } from "./invite-cookie";

// The invite cookie carries a BEARER TOKEN, so it is encrypted+authenticated (AES-256-GCM), not merely
// signed. seal/open are pure over `nowMs` so expiry is deterministic in tests.
const SECRET = "test-secret-abc";
const T0 = 1_000_000;

describe("invite cookie seal/open", () => {
  it("round-trips org + token", async () => {
    const sealed = await sealInvitePayload(
      { org: "org_1", token: "whinv_example_test_value" },
      SECRET,
      T0,
    );
    expect(await openInvitePayload(sealed, SECRET, T0 + 1000)).toEqual({
      org: "org_1",
      token: "whinv_example_test_value",
    });
  });

  it("rejects a tampered ciphertext (GCM tag fails)", async () => {
    const sealed = await sealInvitePayload({ org: "o", token: "t" }, SECRET, T0);
    const flipped = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A");
    expect(await openInvitePayload(flipped, SECRET, T0)).toBeNull();
  });

  it("rejects a wrong key", async () => {
    const sealed = await sealInvitePayload({ org: "o", token: "t" }, SECRET, T0);
    expect(await openInvitePayload(sealed, "other-secret", T0)).toBeNull();
  });

  it("accepts within the TTL and rejects an expired payload (>60 min old)", async () => {
    const sealed = await sealInvitePayload({ org: "o", token: "t" }, SECRET, T0);
    expect(await openInvitePayload(sealed, SECRET, T0 + 59 * 60_000)).toEqual({
      org: "o",
      token: "t",
    });
    expect(await openInvitePayload(sealed, SECRET, T0 + 60 * 60_000 + 1)).toBeNull();
  });

  it("rejects garbage input", async () => {
    expect(await openInvitePayload("not-base64url!!", SECRET, T0)).toBeNull();
    expect(await openInvitePayload("", SECRET, T0)).toBeNull();
  });

  it("produces distinct ciphertexts for the same payload (random iv)", async () => {
    const a = await sealInvitePayload({ org: "o", token: "t" }, SECRET, T0);
    const b = await sealInvitePayload({ org: "o", token: "t" }, SECRET, T0);
    expect(a).not.toBe(b);
  });
});
