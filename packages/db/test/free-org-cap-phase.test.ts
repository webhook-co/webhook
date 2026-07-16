import { describe, expect, it } from "vitest";

import {
  enforcePhase,
  isTotalFreeOrgCapFailure,
  runFreeOrgCapReconcile,
} from "../src/free-org-cap-reconcile";

// The pure decisions behind the cap cron: what an overflow org is owed right now, and when a pass counts as a
// total outage. No database — these are the parts that must be exactly right, so they're tested exactly.

const T = Date.parse("2026-07-01T00:00:00Z");
const DAY = 24 * 3600_000;
const REMINDER_MS = 7 * DAY;
const MIN_LEAD_MS = DAY;

const org = (graceUntil: Date | null, remindedAt: Date | null = null) => ({
  graceUntil,
  remindedAt,
});

describe("enforcePhase", () => {
  it("flags an unflagged org", () => {
    expect(enforcePhase(org(null), T, REMINDER_MS, MIN_LEAD_MS)).toBe("flag");
  });

  it("does nothing early in the grace window — before the reminder is due", () => {
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline), T, REMINDER_MS, MIN_LEAD_MS)).toBeNull();
    expect(enforcePhase(org(deadline), T + 6 * DAY, REMINDER_MS, MIN_LEAD_MS)).toBeNull(); // T-8d
  });

  it("reminds once the deadline is within the reminder window, and only while unreminded", () => {
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline), T + 7 * DAY, REMINDER_MS, MIN_LEAD_MS)).toBe("remind"); // exactly T-7d
    expect(enforcePhase(org(deadline), T + 10 * DAY, REMINDER_MS, MIN_LEAD_MS)).toBe("remind");
    // Already reminded → nothing more until the deadline itself.
    expect(
      enforcePhase(org(deadline, new Date(T + 7 * DAY)), T + 10 * DAY, REMINDER_MS, MIN_LEAD_MS),
    ).toBeNull();
  });

  it("suspends once past the deadline", () => {
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline), T + 14 * DAY, REMINDER_MS, MIN_LEAD_MS)).toBe("suspend"); // exactly at
    expect(
      enforcePhase(org(deadline, new Date(T + 7 * DAY)), T + 20 * DAY, REMINDER_MS, MIN_LEAD_MS),
    ).toBe("suspend");
  });

  it("SUSPEND outranks REMIND for an org past its deadline that was never reminded", () => {
    // Reachable whenever the cron was delayed, or the reminder threw for the whole window. Reminding someone
    // about a deadline that has already passed is worse than useless — it reads as "you still have time".
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline, null), T + 15 * DAY, REMINDER_MS, MIN_LEAD_MS)).toBe(
      "suspend",
    );
  });

  it("does NOT remind once the deadline is too close to act on — the floor", () => {
    // Reachable when the cron gaps across the reminder window, or the reminder threw for a run of passes.
    // A "you'll be suspended on <date>" landing an hour before the suspension email implies time that isn't
    // there; sending nothing and letting the suspension notice speak is the honest outcome.
    const deadline = new Date(T + 14 * DAY);
    expect(enforcePhase(org(deadline), T + 13 * DAY, REMINDER_MS, MIN_LEAD_MS)).toBe("remind"); // T-1d, at the floor
    expect(enforcePhase(org(deadline), T + 13 * DAY + 1, REMINDER_MS, MIN_LEAD_MS)).toBeNull(); // inside it
    expect(enforcePhase(org(deadline), T + 14 * DAY - 60_000, REMINDER_MS, MIN_LEAD_MS)).toBeNull(); // 1min left
  });
});

describe("runFreeOrgCapReconcile — interval guards", () => {
  // These are programming errors in the caller's constants, and both are INVISIBLE in the counters
  // (`reminded: 0` reads exactly like a quiet hour), so they must throw where they're introduced.
  const opts = { now: T, cap: 2, log: () => {} };
  const sql = null as unknown as Parameters<typeof runFreeOrgCapReconcile>[0]; // never reached: guards throw first

  it("throws when reminderMs >= graceMs (the reminder would fire right after the flag)", async () => {
    await expect(
      runFreeOrgCapReconcile(sql, {
        ...opts,
        graceMs: 7 * DAY,
        reminderMs: 7 * DAY,
        minReminderLeadMs: DAY,
      }),
    ).rejects.toThrow(/reminderMs .* must be < graceMs/);
  });

  it("throws when minReminderLeadMs >= reminderMs (the window closes — no reminder, ever)", async () => {
    await expect(
      runFreeOrgCapReconcile(sql, {
        ...opts,
        graceMs: 14 * DAY,
        reminderMs: DAY,
        minReminderLeadMs: DAY,
      }),
    ).rejects.toThrow(/minReminderLeadMs .* must be < reminderMs/);
  });
});

describe("isTotalFreeOrgCapFailure", () => {
  const zero = { attempted: 0, errors: 0 };
  type Phase = "flag" | "remind" | "suspend" | "restore" | "clear_grace";
  const r = (over: Partial<Record<Phase, typeof zero>>) => {
    const phases = {
      flag: zero,
      remind: zero,
      suspend: zero,
      restore: zero,
      clear_grace: zero,
      ...over,
    };
    const all = Object.values(phases);
    return {
      flagged: 0,
      reminded: 0,
      suspended: 0,
      restored: 0,
      graceCleared: 0,
      errors: all.reduce((n, p) => n + p.errors, 0),
      attempted: all.reduce((n, p) => n + p.attempted, 0),
      phases,
    };
  };

  it("is false for a quiet pass — nothing attempted is not everything failed", () => {
    expect(isTotalFreeOrgCapFailure(r({}))).toBe(false);
  });

  it("is false for a healthy pass, and for a PARTIAL failure within a phase", () => {
    expect(
      isTotalFreeOrgCapFailure(
        r({ flag: { attempted: 3, errors: 0 }, restore: { attempted: 2, errors: 0 } }),
      ),
    ).toBe(false);
    expect(isTotalFreeOrgCapFailure(r({ flag: { attempted: 3, errors: 2 } }))).toBe(false);
  });

  it("escalates a dead RESTORE phase even while clear_grace is healthy — the worst failure direction", () => {
    // A regressed ingest_paused grant kills every restore (it writes that table) while every clear_grace
    // succeeds (orgs only). Pooling them as one "undo" scored this partial and never escalated, leaving a
    // customer who just PAID to lift their suspension suspended indefinitely behind `errors: 1`.
    expect(
      isTotalFreeOrgCapFailure(
        r({ restore: { attempted: 2, errors: 2 }, clear_grace: { attempted: 5, errors: 0 } }),
      ),
    ).toBe(true);
  });

  it("is TRUE when ANY ONE phase wholly failed, however healthy the others are", () => {
    // Two regressions this guards. (1) Pooling enforce+undo let one successful restore hide a dead flag loop.
    // (2) Pooling remind+suspend into "enforce" re-created it a level down: a reminder is due on ~168 hourly
    // passes per org vs one for its suspend, so remind successes would swamp the ratio and a total suspend
    // outage (e.g. regressed ingest_paused grants — only suspend touches that table) would read as partial
    // forever.
    expect(
      isTotalFreeOrgCapFailure(
        r({ suspend: { attempted: 2, errors: 2 }, remind: { attempted: 40, errors: 0 } }),
      ),
    ).toBe(true);
    expect(
      isTotalFreeOrgCapFailure(
        r({ flag: { attempted: 3, errors: 3 }, restore: { attempted: 1, errors: 0 } }),
      ),
    ).toBe(true);
    expect(
      isTotalFreeOrgCapFailure(
        r({ restore: { attempted: 2, errors: 2 }, flag: { attempted: 1, errors: 0 } }),
      ),
    ).toBe(true);
  });
});
