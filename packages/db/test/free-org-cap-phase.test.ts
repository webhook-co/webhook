import { describe, expect, it } from "vitest";

import { enforcePhase, isTotalFreeOrgCapFailure } from "../src/free-org-cap-reconcile";

// The pure decisions behind the cap cron: what an overflow org is owed right now, and when a pass counts as a
// total outage. No database — these are the parts that must be exactly right, so they're tested exactly.

const T = Date.parse("2026-07-01T00:00:00Z");
const DAY = 24 * 3600_000;
const REMINDER_MS = 7 * DAY;

const org = (graceUntil: Date | null, remindedAt: Date | null = null) => ({
  graceUntil,
  remindedAt,
});

describe("enforcePhase", () => {
  it("flags an unflagged org", () => {
    expect(enforcePhase(org(null), T, REMINDER_MS)).toBe("flag");
  });

  it("does nothing early in the grace window — before the reminder is due", () => {
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline), T, REMINDER_MS)).toBeNull();
    expect(enforcePhase(org(deadline), T + 6 * DAY, REMINDER_MS)).toBeNull(); // T-8d
  });

  it("reminds once the deadline is within the reminder window, and only while unreminded", () => {
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline), T + 7 * DAY, REMINDER_MS)).toBe("remind"); // exactly T-7d
    expect(enforcePhase(org(deadline), T + 10 * DAY, REMINDER_MS)).toBe("remind");
    // Already reminded → nothing more until the deadline itself.
    expect(
      enforcePhase(org(deadline, new Date(T + 7 * DAY)), T + 10 * DAY, REMINDER_MS),
    ).toBeNull();
  });

  it("suspends once past the deadline", () => {
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline), T + 14 * DAY, REMINDER_MS)).toBe("suspend"); // exactly at
    expect(enforcePhase(org(deadline, new Date(T + 7 * DAY)), T + 20 * DAY, REMINDER_MS)).toBe(
      "suspend",
    );
  });

  it("SUSPEND outranks REMIND for an org past its deadline that was never reminded", () => {
    // Reachable whenever the cron was delayed, or the reminder threw for the whole window. Reminding someone
    // about a deadline that has already passed is worse than useless — it reads as "you still have time".
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline, null), T + 15 * DAY, REMINDER_MS)).toBe("suspend");
  });

  it("a reminder window >= the grace window means the reminder is due immediately after flagging", () => {
    // Documents the boundary rather than defending it: the engine passes 7d vs a 14d grace. If they were
    // equal the second notice would fire on the pass right after the flag and buy no redundancy.
    const deadline = new Date(T + 7 * DAY);
    expect(enforcePhase(org(deadline), T, REMINDER_MS)).toBe("remind");
  });
});

describe("isTotalFreeOrgCapFailure", () => {
  const r = (
    enforce: { attempted: number; errors: number },
    undo: { attempted: number; errors: number },
  ) =>
    ({
      flagged: 0,
      reminded: 0,
      suspended: 0,
      restored: 0,
      graceCleared: 0,
      errors: enforce.errors + undo.errors,
      attempted: enforce.attempted + undo.attempted,
      enforce,
      undo,
    }) as const;

  it("is false for a quiet pass — nothing attempted is not everything failed", () => {
    expect(
      isTotalFreeOrgCapFailure(r({ attempted: 0, errors: 0 }, { attempted: 0, errors: 0 })),
    ).toBe(false);
  });

  it("is false for a healthy pass, and for a PARTIAL failure within a loop", () => {
    expect(
      isTotalFreeOrgCapFailure(r({ attempted: 3, errors: 0 }, { attempted: 2, errors: 0 })),
    ).toBe(false);
    expect(
      isTotalFreeOrgCapFailure(r({ attempted: 3, errors: 2 }, { attempted: 0, errors: 0 })),
    ).toBe(false);
  });

  it("is TRUE when a loop wholly failed — even if the OTHER loop was perfectly healthy", () => {
    // The regression this exists for: pooling both loops into one ratio let a single successful restore
    // (undo 1/1 ok) mask a totally broken enforce loop (3/3 failed, e.g. a rolled-back grant), so the cap sat
    // unenforced every hour behind a healthy-looking log line.
    expect(
      isTotalFreeOrgCapFailure(r({ attempted: 3, errors: 3 }, { attempted: 1, errors: 0 })),
    ).toBe(true);
    expect(
      isTotalFreeOrgCapFailure(r({ attempted: 1, errors: 0 }, { attempted: 2, errors: 2 })),
    ).toBe(true);
  });
});
