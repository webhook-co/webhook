import { describe, expect, it } from "vitest";

import {
  EXPIRY_SWEEP_UTC_HOUR,
  dispatchAuthScheduled,
  runsExpirySweep,
  type AuthScheduledCrons,
} from "./scheduled";

// apps/auth declares ONE hourly trigger ("0 * * * *") but runs a DAILY job behind it. Before this module
// that split lived as an inline `new Date(event.scheduledTime).getUTCHours() === 4` inside src/worker.ts —
// a file that is tsconfig-EXCLUDED (it imports the gitignored .open-next bundle), so the predicate was not
// merely untested but unreachable by any test, and its failure mode is silent: get the hour wrong and the
// ADR-0055 cross-org expiry sweep simply never runs again, with no error and no alert.

/** Records which crons ran, without touching a database. */
function recordingCrons(): { crons: AuthScheduledCrons; ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    crons: {
      notificationDrain: async () => {
        ran.push("notificationDrain");
        return null;
      },
      expirySweep: async () => {
        ran.push("expirySweep");
        return null;
      },
    },
  };
}

/** Midnight UTC on 2026-07-22, plus `hour` hours — a stable base for the gate tests. */
const atUtcHour = (hour: number): number => Date.UTC(2026, 6, 22, hour, 0, 0, 0);

async function dispatchAt(
  scheduledTime: number,
): Promise<{ ran: string[]; units: Promise<unknown>[] }> {
  const { crons, ran } = recordingCrons();
  const units: Promise<unknown>[] = [];
  dispatchAuthScheduled({ scheduledTime }, {}, (p) => units.push(p), crons);
  await Promise.all(units);
  return { ran, units };
}

describe("runsExpirySweep", () => {
  it("runs the sweep at 04:00 UTC — the agreed low-traffic window", () => {
    // PINNED TO A LITERAL ON PURPOSE. Every other assertion here is written against
    // EXPIRY_SWEEP_UTC_HOUR, which means editing that constant would move the source AND the
    // expectations together and stay green. The hour is an operational decision (a low-traffic window,
    // chosen so the cross-org sweep never contends with peak load), so changing it must be deliberate
    // and reviewed — not something a one-character edit does silently.
    expect(EXPIRY_SWEEP_UTC_HOUR).toBe(4);
    expect(runsExpirySweep(Date.UTC(2026, 6, 22, 4, 0, 0, 0))).toBe(true);
    expect(runsExpirySweep(Date.UTC(2026, 6, 22, 5, 0, 0, 0))).toBe(false);
    expect(runsExpirySweep(Date.UTC(2026, 6, 22, 3, 0, 0, 0))).toBe(false);
  });

  it("is true ONLY at the designated UTC hour", () => {
    for (let hour = 0; hour < 24; hour++) {
      expect(runsExpirySweep(atUtcHour(hour))).toBe(hour === EXPIRY_SWEEP_UTC_HOUR);
    }
  });

  it("covers the whole hour, not just the exact instant", () => {
    // Cron fires at :00, but a delayed dispatch later in the hour must still sweep.
    expect(runsExpirySweep(Date.UTC(2026, 6, 22, EXPIRY_SWEEP_UTC_HOUR, 0, 0, 0))).toBe(true);
    expect(runsExpirySweep(Date.UTC(2026, 6, 22, EXPIRY_SWEEP_UTC_HOUR, 59, 59, 999))).toBe(true);
    // ...and the hours either side must NOT.
    expect(runsExpirySweep(Date.UTC(2026, 6, 22, EXPIRY_SWEEP_UTC_HOUR - 1, 59, 59, 999))).toBe(
      false,
    );
    expect(runsExpirySweep(Date.UTC(2026, 6, 22, EXPIRY_SWEEP_UTC_HOUR + 1, 0, 0, 0))).toBe(false);
  });

  it("reads the hour in UTC, not local time", () => {
    // A Date whose LOCAL hour differs from its UTC hour must be judged on UTC. Asserting through the
    // UTC accessor keeps this true on any CI timezone.
    const t = Date.UTC(2026, 0, 15, EXPIRY_SWEEP_UTC_HOUR, 30, 0, 0);
    expect(new Date(t).getUTCHours()).toBe(EXPIRY_SWEEP_UTC_HOUR);
    expect(runsExpirySweep(t)).toBe(true);
  });

  it("accepts a Date as well as an epoch-millis number", () => {
    expect(runsExpirySweep(new Date(atUtcHour(EXPIRY_SWEEP_UTC_HOUR)))).toBe(true);
    expect(runsExpirySweep(new Date(atUtcHour(EXPIRY_SWEEP_UTC_HOUR + 1)))).toBe(false);
  });
});

describe("dispatchAuthScheduled", () => {
  it("runs the notification drain on EVERY hourly tick", async () => {
    for (let hour = 0; hour < 24; hour++) {
      const { ran } = await dispatchAt(atUtcHour(hour));
      expect(ran).toContain("notificationDrain");
    }
  });

  it("runs the expiry sweep ONLY on the designated hour — by name, not by count", async () => {
    const sweepHour = await dispatchAt(atUtcHour(EXPIRY_SWEEP_UTC_HOUR));
    expect(sweepHour.ran.sort()).toEqual(["expirySweep", "notificationDrain"]);

    const otherHour = await dispatchAt(atUtcHour(EXPIRY_SWEEP_UTC_HOUR + 1));
    expect(otherHour.ran).toEqual(["notificationDrain"]);
  });

  it("hands each cron to waitUntil as its own unit, so neither can starve the other", async () => {
    const { units } = await dispatchAt(atUtcHour(EXPIRY_SWEEP_UTC_HOUR));
    expect(units).toHaveLength(2);

    const offHour = await dispatchAt(atUtcHour(0));
    expect(offHour.units).toHaveLength(1);
  });

  it("does not reject when a cron fails — a cron failure must not wedge the invocation", async () => {
    const units: Promise<unknown>[] = [];
    dispatchAuthScheduled(
      { scheduledTime: atUtcHour(EXPIRY_SWEEP_UTC_HOUR) },
      {},
      (p) => units.push(p),
      {
        notificationDrain: async () => {
          throw new Error("drain exploded");
        },
        expirySweep: async () => null,
      },
    );
    // Both units still settle; the failing one resolves rather than rejecting, so it cannot surface as
    // an unhandled rejection at the invocation boundary.
    await expect(Promise.all(units)).resolves.toHaveLength(2);
  });
});
