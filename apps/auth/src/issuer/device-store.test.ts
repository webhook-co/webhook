import { describe, expect, it } from "vitest";

import {
  createDeviceCode,
  findByUserCode,
  pollDeviceCode,
  setDeviceDecision,
  type DeviceKv,
  type DeviceStoreDeps,
} from "./device-store";

// A4a — the RFC 8628 device-code store over KV (the provider has no device grant, and a device code has no
// org until approval, so it can't live in a tenant-RLS table — KV with TTL is the store). Single-use is
// claimed at poll time (delete-on-read of an approved/denied code). Tested against an in-memory fake KV.

/** A fake KV that keeps values (TTL is exercised via the record's own expiresAt + the injected clock). */
function fakeKv(): DeviceKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
  };
}

let counter = 0;
function deps(kv: DeviceKv, now = 1_000): DeviceStoreDeps {
  // Deterministic "random": a counter-filled buffer so each code is distinct across calls in a test.
  return {
    kv,
    nowSeconds: () => now,
    randomBytes: (n) => {
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = (counter + i) % 256;
      counter += 7;
      return b;
    },
  };
}

const CREATE = {
  clientId: "cli_wbhk",
  scopes: ["events:read", "events:replay"],
  audience: "https://api.webhook.co",
  ttlSeconds: 900,
  interval: 5,
};

describe("createDeviceCode", () => {
  it("returns a device code + a canonical user code and stores a pending record under two keys", async () => {
    const kv = fakeKv();
    const res = await createDeviceCode(deps(kv), CREATE);
    expect(res.deviceCode.length).toBeGreaterThan(20);
    expect(res.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.interval).toBe(5);
    expect(res.expiresIn).toBe(900);
    // two keys written (the dc record + the uc index pointer).
    expect(kv.store.size).toBe(2);

    const found = await findByUserCode(deps(kv), res.userCode);
    expect(found).not.toBeNull();
    expect(found!.status).toBe("pending");
    expect(found!.clientId).toBe("cli_wbhk");
    expect(found!.scopes).toEqual(["events:read", "events:replay"]);
    expect(found!.audience).toBe("https://api.webhook.co");
  });

  it("does not use ambiguous characters (0/O/1/I/L) in the user code", async () => {
    const kv = fakeKv();
    for (let i = 0; i < 12; i++) {
      const { userCode } = await createDeviceCode(deps(kv), CREATE);
      expect(userCode).not.toMatch(/[O0I1L]/);
    }
  });
});

describe("user-code RNG (unbiased mapping)", () => {
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // mirror of USER_CODE_ALPHABET (31 chars)

  /** A deps() whose randomBytes serves a fixed queue of bytes, refilling with a benign filler when drained. */
  function depsWithBytes(kv: DeviceKv, queue: number[], filler = 0): DeviceStoreDeps {
    let i = 0;
    return {
      kv,
      nowSeconds: () => 1_000,
      randomBytes: (n) => {
        const b = new Uint8Array(n);
        for (let j = 0; j < n; j++) b[j] = i < queue.length ? queue[i++]! : filler;
        return b;
      },
    };
  }

  it("emits only alphabet characters in the canonical XXXX-XXXX shape", async () => {
    const kv = fakeKv();
    for (let k = 0; k < 16; k++) {
      const { userCode } = await createDeviceCode(deps(kv), CREATE);
      expect(userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      for (const ch of userCode.replace("-", "")) {
        expect(ALPHABET).toContain(ch);
      }
    }
  });

  // Rejection sampling: 31 doesn't divide 256, so bytes in [248, 255] (the 8 leftover values above
  // floor(256/31)*31 = 248) must be discarded — not mapped through `% 31` — to keep every symbol equally
  // likely. Feed a run of reject-range bytes ahead of a valid one and assert the rejects never reach the code.
  it("discards reject-range bytes (>= 248) rather than mapping them, eliminating modulo bias", async () => {
    const kv = fakeKv();
    // createDeviceCode draws the 32-byte device code first; lead the queue with 32 benign bytes so the
    // user-code draw begins on the bytes we control.
    const DEVICE_CODE_BYTES = 32;
    const queue: number[] = new Array(DEVICE_CODE_BYTES).fill(0);
    // Each of the 8 user-code positions: reject byte(s) (>= 248) then a 0 -> ALPHABET[0] = "A". Position 0
    // exercises the full reject run 248..255; the rest use a single 255. So the whole code must be "AAAA-AAAA".
    for (let pos = 0; pos < 8; pos++) {
      if (pos === 0) for (let r = 248; r <= 255; r++) queue.push(r);
      else queue.push(255);
      queue.push(0);
    }
    const { userCode } = await createDeviceCode(depsWithBytes(kv, queue), CREATE);
    // If reject bytes were (buggily) mapped via %31 the output would NOT be all "A" (255 % 31 = 7 -> "H"), so
    // asserting the canonical all-"A" output proves the rejects were skipped, i.e. rejection sampling is live.
    expect(userCode).toBe("AAAA-AAAA");
  });
});

describe("findByUserCode", () => {
  it("returns null for an unknown user code", async () => {
    const kv = fakeKv();
    expect(await findByUserCode(deps(kv), "ZZZZ-ZZZZ")).toBeNull();
  });

  it("returns null once the record is past its expiry (defense beyond the KV TTL)", async () => {
    const kv = fakeKv();
    const { userCode } = await createDeviceCode(deps(kv, 1_000), CREATE);
    expect(await findByUserCode(deps(kv, 1_000 + 901), userCode)).toBeNull();
  });

  it("tolerates case + missing dash + spaces in the entered code (RFC 8628 §6.1)", async () => {
    const kv = fakeKv();
    const { userCode } = await createDeviceCode(deps(kv), CREATE); // canonical XXXX-XXXX
    const lowerNoDash = userCode.toLowerCase().replace("-", "");
    const spaced = `  ${userCode.slice(0, 4)} ${userCode.slice(5)}  `;
    expect(await findByUserCode(deps(kv), lowerNoDash)).not.toBeNull();
    expect(await findByUserCode(deps(kv), spaced)).not.toBeNull();
  });
});

describe("setDeviceDecision", () => {
  it("approves a pending record, recording the consent props", async () => {
    const kv = fakeKv();
    const { userCode } = await createDeviceCode(deps(kv), CREATE);
    const result = await setDeviceDecision(deps(kv), userCode, {
      decision: "approve",
      props: {
        orgId: "org_1",
        userId: "user_dana",
        scopes: ["events:read"],
        audience: "https://api.webhook.co",
        device: { name: "Dana's laptop" },
      },
    });
    expect(result).toBe("ok");
    const found = await findByUserCode(deps(kv), userCode);
    expect(found!.status).toBe("approved");
    expect(found!.orgId).toBe("org_1");
    expect(found!.userId).toBe("user_dana");
    expect(found!.grantScopes).toEqual(["events:read"]);
    expect(found!.deviceName).toBe("Dana's laptop");
  });

  it("denies a pending record", async () => {
    const kv = fakeKv();
    const { userCode } = await createDeviceCode(deps(kv), CREATE);
    expect(await setDeviceDecision(deps(kv), userCode, { decision: "deny" })).toBe("ok");
    expect((await findByUserCode(deps(kv), userCode))!.status).toBe("denied");
  });

  it("returns not_found for an unknown code and already_decided for a non-pending one", async () => {
    const kv = fakeKv();
    expect(await setDeviceDecision(deps(kv), "ZZZZ-ZZZZ", { decision: "deny" })).toBe("not_found");
    const { userCode } = await createDeviceCode(deps(kv), CREATE);
    await setDeviceDecision(deps(kv), userCode, { decision: "deny" });
    expect(
      await setDeviceDecision(deps(kv), userCode, {
        decision: "approve",
        props: {
          orgId: "o",
          userId: "u",
          scopes: ["events:read"],
          audience: "https://api.webhook.co",
        },
      }),
    ).toBe("already_decided");
  });

  // A decision made in the final 60s of the code's window must still persist: the KV minimum-TTL skip is for
  // the cosmetic poll re-write only, never for a status change. Otherwise the consent UI shows success while
  // the poller keeps seeing `pending` until the code expires (the approval is silently lost).
  it("persists an approval decided in the final 60s of the window (sub-minute remaining TTL)", async () => {
    const kv = fakeKv();
    // ttl=900, so a decision at createdAt+870 leaves 30s < the 60s KV minimum.
    const { deviceCode, userCode } = await createDeviceCode(deps(kv, 1_000), CREATE);
    const result = await setDeviceDecision(deps(kv, 1_870), userCode, {
      decision: "approve",
      props: {
        orgId: "org_1",
        userId: "user_dana",
        scopes: ["events:read"],
        audience: "https://api.webhook.co",
        device: { name: "laptop" },
      },
    });
    expect(result).toBe("ok");
    // The poller (still within the window) must see the approval, not a stale `pending`.
    const poll = await pollDeviceCode(deps(kv, 1_875), deviceCode);
    expect(poll.kind).toBe("approved");
  });

  it("persists a denial decided in the final 60s of the window (sub-minute remaining TTL)", async () => {
    const kv = fakeKv();
    const { deviceCode, userCode } = await createDeviceCode(deps(kv, 1_000), CREATE);
    expect(await setDeviceDecision(deps(kv, 1_870), userCode, { decision: "deny" })).toBe("ok");
    expect((await pollDeviceCode(deps(kv, 1_875), deviceCode)).kind).toBe("denied");
  });
});

describe("pollDeviceCode (RFC 8628 FSM)", () => {
  it("returns pending for an unapproved code", async () => {
    const kv = fakeKv();
    const { deviceCode } = await createDeviceCode(deps(kv, 1_000), CREATE);
    expect((await pollDeviceCode(deps(kv, 1_000), deviceCode)).kind).toBe("pending");
  });

  it("returns slow_down when polled again before the interval elapses", async () => {
    const kv = fakeKv();
    const { deviceCode } = await createDeviceCode(deps(kv, 1_000), CREATE);
    expect((await pollDeviceCode(deps(kv, 1_000), deviceCode)).kind).toBe("pending");
    // a second poll within the 5s interval is too fast.
    expect((await pollDeviceCode(deps(kv, 1_002), deviceCode)).kind).toBe("slow_down");
    // after the (penalised) interval, polling resumes as pending.
    expect((await pollDeviceCode(deps(kv, 1_100), deviceCode)).kind).toBe("pending");
  });

  it("returns approved with the consent props, then is single-use (a re-poll is invalid)", async () => {
    const kv = fakeKv();
    const { deviceCode, userCode } = await createDeviceCode(deps(kv, 1_000), CREATE);
    await setDeviceDecision(deps(kv, 1_000), userCode, {
      decision: "approve",
      props: {
        orgId: "org_1",
        userId: "user_dana",
        scopes: ["events:read"],
        audience: "https://api.webhook.co",
        device: { name: "laptop" },
      },
    });
    const poll = await pollDeviceCode(deps(kv, 1_010), deviceCode);
    expect(poll).toEqual({
      kind: "approved",
      props: {
        orgId: "org_1",
        userId: "user_dana",
        scopes: ["events:read"],
        audience: "https://api.webhook.co",
        device: { name: "laptop" },
      },
    });
    // single-use: both KV keys are gone, so a re-poll (replay) is invalid.
    expect(kv.store.size).toBe(0);
    expect((await pollDeviceCode(deps(kv, 1_011), deviceCode)).kind).toBe("invalid");
  });

  it("returns denied for a denied code, then is single-use", async () => {
    const kv = fakeKv();
    const { deviceCode, userCode } = await createDeviceCode(deps(kv, 1_000), CREATE);
    await setDeviceDecision(deps(kv, 1_000), userCode, { decision: "deny" });
    expect((await pollDeviceCode(deps(kv, 1_010), deviceCode)).kind).toBe("denied");
    expect(kv.store.size).toBe(0);
  });

  it("returns invalid for an unknown or expired device code", async () => {
    const kv = fakeKv();
    expect((await pollDeviceCode(deps(kv), "whatever")).kind).toBe("invalid");
    const { deviceCode } = await createDeviceCode(deps(kv, 1_000), CREATE);
    expect((await pollDeviceCode(deps(kv, 1_000 + 901), deviceCode)).kind).toBe("invalid");
  });
});
