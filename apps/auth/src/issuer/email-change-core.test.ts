import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  commitEmailChange,
  isPlausibleEmail,
  startEmailChange,
  type EmailChangeOps,
} from "./email-change-core";

const CODE = "123456";
const HASH = new Uint8Array([9, 9, 9]);

function makeOps(over: Partial<EmailChangeOps> = {}): EmailChangeOps {
  return {
    now: () => 1_000_000,
    maxAttempts: 5,
    otpTtlSeconds: 600,
    readProfile: vi.fn(async () => ({ email: "old@e.test" })),
    emailInUseByAnother: vi.fn(async () => false),
    rateLimitSend: vi.fn(async () => true),
    generateOtp: vi.fn(() => CODE),
    hashOtp: vi.fn(async () => HASH),
    upsertPending: vi.fn(async () => {}),
    sendOtpEmail: vi.fn(async () => {}),
    readPending: vi.fn(async () => ({
      newEmail: "new@e.test",
      codeHash: HASH,
      expiresAt: new Date(2_000_000),
      attempts: 0,
    })),
    rateLimitVerify: vi.fn(async () => true),
    bumpAttempts: vi.fn(async () => 1),
    otpMatches: vi.fn(
      (a, b) => a === b || (a.length === b.length && a.every((x, i) => x === b[i])),
    ),
    commitEmail: vi.fn(async () => {}),
    isEmailTaken: vi.fn(() => false),
    deleteAllSessions: vi.fn(async () => {}),
    purgeVerifications: vi.fn(async () => {}),
    deletePending: vi.fn(async () => {}),
    sendChangedNotice: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("isPlausibleEmail", () => {
  it("accepts a normal address and rejects the obvious junk", () => {
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    expect(isPlausibleEmail("a.b+tag@sub.example.com")).toBe(true);
    expect(isPlausibleEmail("no-at")).toBe(false);
    expect(isPlausibleEmail("a@b")).toBe(false); // no dot in domain
    expect(isPlausibleEmail("a b@c.co")).toBe(false); // space
  });

  it("rejects HTML-significant characters (keeps markup out of the identity column + outbound email)", () => {
    expect(isPlausibleEmail("<img/src=x/onerror=alert(1)>@e.co")).toBe(false);
    expect(isPlausibleEmail('a"@e.co')).toBe(false);
    expect(isPlausibleEmail("a'@e.co")).toBe(false);
    expect(isPlausibleEmail("a>@e.co")).toBe(false);
  });
});

describe("startEmailChange", () => {
  it("sends the OTP to the CURRENT email (step-up), not the new one, and stores BEFORE sending", async () => {
    const ops = makeOps();
    const res = await startEmailChange(ops, { userId: "u1", newEmail: "New@E.test" });
    expect(res.ok).toBe(true);
    // stored the (lowercased) target + a hash, THEN emailed the code to the current address on record
    expect(ops.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", newEmail: "new@e.test", codeHash: HASH }),
    );
    expect(ops.sendOtpEmail).toHaveBeenCalledWith("old@e.test", CODE);
  });

  it("rejects an invalid address before any side effect", async () => {
    const ops = makeOps();
    expect((await startEmailChange(ops, { userId: "u1", newEmail: "nope" })).reason).toBe(
      "invalid",
    );
    expect(ops.upsertPending).not.toHaveBeenCalled();
    expect(ops.sendOtpEmail).not.toHaveBeenCalled();
  });

  it("rejects changing to your own current address (case-insensitive)", async () => {
    const ops = makeOps();
    expect((await startEmailChange(ops, { userId: "u1", newEmail: "OLD@e.test" })).reason).toBe(
      "same",
    );
  });

  it("rejects an address already used by another account, without sending", async () => {
    const ops = makeOps({ emailInUseByAnother: vi.fn(async () => true) });
    const res = await startEmailChange(ops, { userId: "u1", newEmail: "taken@e.test" });
    expect(res).toMatchObject({ ok: false, reason: "taken" });
    expect(ops.sendOtpEmail).not.toHaveBeenCalled();
  });

  it("throttles the send (rate limit) without storing or sending", async () => {
    const ops = makeOps({ rateLimitSend: vi.fn(async () => false) });
    expect((await startEmailChange(ops, { userId: "u1", newEmail: "n@e.test" })).reason).toBe(
      "rate_limited",
    );
    expect(ops.upsertPending).not.toHaveBeenCalled();
  });
});

describe("commitEmailChange", () => {
  it("on the right code: commits, revokes ALL sessions, purges BOTH addresses, notifies the OLD one", async () => {
    const ops = makeOps();
    const res = await commitEmailChange(ops, { userId: "u1", code: CODE });
    expect(res).toEqual({ ok: true, oldEmail: "old@e.test", newEmail: "new@e.test" });
    expect(ops.commitEmail).toHaveBeenCalledWith("u1", "new@e.test");
    expect(ops.deleteAllSessions).toHaveBeenCalledWith("u1");
    expect(ops.purgeVerifications).toHaveBeenCalledWith(["old@e.test", "new@e.test"]);
    expect(ops.deletePending).toHaveBeenCalledWith("u1");
    expect(ops.sendChangedNotice).toHaveBeenCalledWith("old@e.test", "new@e.test");
  });

  it("still SUCCEEDS if the courtesy notice to the old address fails (best-effort — the change committed)", async () => {
    const ops = makeOps({
      sendChangedNotice: vi.fn(async () => {
        throw new Error("resend 503");
      }),
    });
    const res = await commitEmailChange(ops, { userId: "u1", code: CODE });
    expect(res.ok).toBe(true); // a mail-send blip must not turn a committed change into a failure
    // The security steps still ran (they precede the advisory notice).
    expect(ops.commitEmail).toHaveBeenCalled();
    expect(ops.deleteAllSessions).toHaveBeenCalled();
    expect(ops.deletePending).toHaveBeenCalled();
  });

  it("refuses when there's no pending change", async () => {
    const ops = makeOps({ readPending: vi.fn(async () => null) });
    expect((await commitEmailChange(ops, { userId: "u1", code: CODE })).reason).toBe("no_pending");
    expect(ops.commitEmail).not.toHaveBeenCalled();
  });

  it("expires an old pending row (and deletes it), committing nothing", async () => {
    const ops = makeOps({
      readPending: vi.fn(async () => ({
        newEmail: "new@e.test",
        codeHash: HASH,
        expiresAt: new Date(500_000), // before now()=1_000_000
        attempts: 0,
      })),
    });
    expect((await commitEmailChange(ops, { userId: "u1", code: CODE })).reason).toBe("expired");
    expect(ops.deletePending).toHaveBeenCalledWith("u1");
    expect(ops.commitEmail).not.toHaveBeenCalled();
  });

  it("locks out once attempts hit the max — never even checks the code", async () => {
    const ops = makeOps({
      readPending: vi.fn(async () => ({
        newEmail: "new@e.test",
        codeHash: HASH,
        expiresAt: new Date(2_000_000),
        attempts: 5,
      })),
    });
    expect((await commitEmailChange(ops, { userId: "u1", code: CODE })).reason).toBe("locked");
    expect(ops.hashOtp).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED when the verify rate-limit faults (treated as locked, no code check)", async () => {
    const ops = makeOps({ rateLimitVerify: vi.fn(async () => false) });
    expect((await commitEmailChange(ops, { userId: "u1", code: CODE })).reason).toBe("locked");
    expect(ops.commitEmail).not.toHaveBeenCalled();
  });

  it("bumps attempts on a wrong code and commits nothing", async () => {
    const ops = makeOps({ hashOtp: vi.fn(async () => new Uint8Array([1, 2, 3])) }); // ≠ stored HASH
    const res = await commitEmailChange(ops, { userId: "u1", code: "000000" });
    expect(res.reason).toBe("invalid_code");
    expect(ops.bumpAttempts).toHaveBeenCalledWith("u1");
    expect(ops.commitEmail).not.toHaveBeenCalled();
    expect(ops.deleteAllSessions).not.toHaveBeenCalled();
  });

  it("returns 'locked' when a wrong code pushes attempts to the max", async () => {
    const ops = makeOps({
      hashOtp: vi.fn(async () => new Uint8Array([1, 2, 3])),
      bumpAttempts: vi.fn(async () => 5),
    });
    expect((await commitEmailChange(ops, { userId: "u1", code: "000000" })).reason).toBe("locked");
  });

  it("surfaces a TOCTOU collision (address taken between start and commit) and clears the pending row", async () => {
    const ops = makeOps({
      commitEmail: vi.fn(async () => {
        throw { code: "23505", constraint_name: "user_email_key" };
      }),
      isEmailTaken: vi.fn(() => true),
    });
    const res = await commitEmailChange(ops, { userId: "u1", code: CODE });
    expect(res).toMatchObject({ ok: false, reason: "taken" });
    expect(ops.deletePending).toHaveBeenCalledWith("u1");
    expect(ops.deleteAllSessions).not.toHaveBeenCalled(); // nothing changed → no revoke
  });
});
