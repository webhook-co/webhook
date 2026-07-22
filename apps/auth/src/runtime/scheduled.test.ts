import { afterEach, describe, expect, it, vi } from "vitest";

import { runNotificationDrain } from "./notify-cron";
import {
  DEFAULT_CRONS,
  EXPIRY_SWEEP_UTC_HOUR,
  dispatchAuthScheduled,
  runsExpirySweep,
  type AuthScheduledCrons,
} from "./scheduled";
import { runAuthExpirySweep } from "./sweep-cron";

// apps/auth declares ONE hourly trigger ("0 * * * *") but runs a DAILY job behind it. Before this module
// that split lived as an inline `new Date(event.scheduledTime).getUTCHours() === 4` inside src/worker.ts —
// a file that is tsconfig-EXCLUDED (it imports the gitignored .open-next bundle), so the predicate was not
// merely untested but unreachable by any test, and its failure mode is silent: get the hour wrong and the
// ADR-0055 cross-org expiry sweep simply never runs again, with no error and no alert.

/** Records which crons ran AND what env each was handed, without touching a database. */
function recordingCrons(): {
  crons: AuthScheduledCrons;
  ran: string[];
  envs: Record<string, unknown>[];
} {
  const ran: string[] = [];
  const envs: Record<string, unknown>[] = [];
  return {
    ran,
    envs,
    crons: {
      notificationDrain: async (env) => {
        ran.push("notificationDrain");
        envs.push(env);
        return null;
      },
      expirySweep: async (env) => {
        ran.push("expirySweep");
        envs.push(env);
        return null;
      },
    },
  };
}

/** Midnight UTC on 2026-07-22, plus `hour` hours — a stable base for the gate tests. */
const atUtcHour = (hour: number): number => Date.UTC(2026, 6, 22, hour, 0, 0, 0);

async function dispatchAt(
  scheduledTime: number,
  env: Record<string, unknown> = {},
): Promise<{ ran: string[]; envs: Record<string, unknown>[]; units: Promise<unknown>[] }> {
  const { crons, ran, envs } = recordingCrons();
  const units: Promise<unknown>[] = [];
  dispatchAuthScheduled({ scheduledTime }, env, (p) => units.push(p), crons);
  await Promise.all(units);
  return { ran, envs, units };
}

/**
 * Capture only the DISPATCH-level log lines (`stage: "dispatch"`) — the ones `absorb` emits, which is
 * what every assertion below is about. The dispatch also emits heartbeat lines now; those are
 * asserted separately rather than allowed to perturb these counts.
 */
function captureLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    try {
      if ((JSON.parse(line) as { stage?: string }).stage === "dispatch") lines.push(line);
    } catch {
      lines.push(line);
    }
  });
  return lines;
}

/** Every captured line, dispatch or not — for asserting on the heartbeat's own output. */
function captureAllLogs(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("does not sweep on an unparseable scheduledTime", () => {
    // getUTCHours() on an Invalid Date is NaN, which is never === the hour. Pinned so a future
    // "defensive" default cannot quietly turn a malformed firing into a sweep.
    expect(runsExpirySweep(Number.NaN)).toBe(false);
    expect(runsExpirySweep(new Date("not a date"))).toBe(false);
  });
});

describe("DEFAULT_CRONS", () => {
  it("wires the real crons to the right fields", () => {
    // Every dispatch test below injects its own fakes, so the DEFAULT wiring is otherwise never executed.
    // Swap these two fields and the whole suite stays green while production runs the cross-org expiry
    // sweep hourly and drains owner notifications once a day. Both have the same signature, so tsc cannot
    // see the swap either — only an identity assertion can.
    expect(DEFAULT_CRONS.notificationDrain).toBe(runNotificationDrain);
    expect(DEFAULT_CRONS.expirySweep).toBe(runAuthExpirySweep);
  });

  it("is what dispatchAuthScheduled uses when no crons are injected", async () => {
    // Drives the real modules. Hermetic: with a bare env both validate-and-return-null before any I/O
    // (proven in notify-cron / sweep-cron tests), so this touches no database.
    const units: Promise<unknown>[] = [];
    captureLogs();

    dispatchAuthScheduled({ scheduledTime: atUtcHour(EXPIRY_SWEEP_UTC_HOUR) }, {}, (p) =>
      units.push(p),
    );

    expect(units).toHaveLength(2);
    await expect(Promise.all(units)).resolves.toHaveLength(2);
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

  it("passes the REAL env to every cron, not a substitute", async () => {
    // Handing a cron `{}` instead of `env` is silent: both crons validate their env and return null, so
    // they no-op exactly as they would on an unprovisioned deployment. Owner auto-disable emails would
    // simply stop, with a suite that never noticed. Identity, not shape.
    const env = { HYPERDRIVE_SWEEPER: { connectionString: "x" }, marker: Symbol("env") };
    const { envs } = await dispatchAt(atUtcHour(EXPIRY_SWEEP_UTC_HOUR), env);

    expect(envs).toHaveLength(2);
    for (const seen of envs) expect(seen).toBe(env);
  });

  // Both arms must be covered: the arm whose regression actually causes the double-send the module's
  // docblock warns about is the SWEEP arm, and it only runs on one hour of the day.
  for (const arm of [
    { cron: "notificationDrain", message: "auth.notify.cron.error" },
    { cron: "expirySweep", message: "auth.sweep.cron.error" },
  ] as const) {
    it(`absorbs a ${arm.cron} failure — it must not wedge the invocation`, async () => {
      const lines = captureLogs();
      const units: Promise<unknown>[] = [];
      dispatchAuthScheduled(
        { scheduledTime: atUtcHour(EXPIRY_SWEEP_UTC_HOUR) },
        {},
        (p) => units.push(p),
        {
          notificationDrain: async () =>
            arm.cron === "notificationDrain" ? Promise.reject(new Error("boom")) : null,
          expirySweep: async () =>
            arm.cron === "expirySweep" ? Promise.reject(new Error("boom")) : null,
        },
      );

      // Both units settle; the failing one resolves rather than rejecting, so it cannot surface as an
      // unhandled rejection at the invocation boundary and leave the runtime's retry flag set.
      await expect(Promise.all(units)).resolves.toHaveLength(2);
      const entries = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe(arm.message);
      expect(entries[0].stage).toBe("dispatch");
    });

    it(`absorbs a SYNCHRONOUS throw from ${arm.cron}`, async () => {
      // AuthScheduledCrons types the crons as `=> Promise<…>`, not `async`. A non-async implementation
      // that throws before returning its promise would propagate out of the dispatch and out of
      // scheduled() entirely, skipping every cron below it.
      const lines = captureLogs();
      const units: Promise<unknown>[] = [];
      const boom = (): Promise<unknown> => {
        throw new Error("sync boom");
      };
      dispatchAuthScheduled(
        { scheduledTime: atUtcHour(EXPIRY_SWEEP_UTC_HOUR) },
        {},
        (p) => units.push(p),
        {
          notificationDrain: arm.cron === "notificationDrain" ? boom : async () => null,
          expirySweep: arm.cron === "expirySweep" ? boom : async () => null,
        },
      );

      expect(units).toHaveLength(2);
      await expect(Promise.all(units)).resolves.toHaveLength(2);
      expect(lines.map((l) => (JSON.parse(l) as { message: string }).message)).toEqual([
        arm.message,
      ]);
    });
  }

  it("never puts a failure's MESSAGE in the log line — only its name", async () => {
    // The one frame that can reach the dispatch-level catch is each cron's createClient(...) call, which
    // sits OUTSIDE its try block and takes the Hyperdrive connection string — a role credential — as its
    // live argument. So the dispatch must not log a raw error message, whatever an upstream library
    // chooses to put in it. Asserted on the field that would ACTUALLY carry the credential in production.
    const secret = "postgres://webhook_sweeper:SUPER_SECRET@db.invalid/neondb";
    const lines = captureLogs();
    const units: Promise<unknown>[] = [];

    dispatchAuthScheduled(
      { scheduledTime: atUtcHour(EXPIRY_SWEEP_UTC_HOUR) },
      {},
      (p) => units.push(p),
      {
        notificationDrain: async () => {
          throw new Error(`connect failed for ${secret}`);
        },
        expirySweep: async () => null,
      },
    );
    await Promise.all(units);

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.message).toBe("auth.notify.cron.error");
    expect(entry.error).toBe("Error");
    expect(lines[0]).not.toContain("SUPER_SECRET");
    expect(lines[0]).not.toContain("webhook_sweeper");
  });
});

describe("heartbeat reporting", () => {
  // The dead-man's switch is only useful if a FAILED run is distinguishable from a healthy one.
  // Both auth crons signal failure by returning null rather than throwing, so `absorb` must pass
  // that value through to the heartbeat instead of discarding it.
  it("reports a failed run without leaking the failure's message", async () => {
    const lines = captureAllLogs();
    const units: Promise<unknown>[] = [];
    dispatchAuthScheduled({ scheduledTime: Date.UTC(2026, 0, 1, 12) }, {}, (p) => units.push(p), {
      notificationDrain: async () => {
        throw new Error("connection string postgres://user:pw@host/db");
      },
      expirySweep: async () => null,
    });
    await Promise.all(units);

    const heartbeat = lines.filter((l) => l.includes("reported failure"));
    expect(heartbeat.length).toBe(1);
    // absorb converts the throw to null before the heartbeat sees it, so the heartbeat line carries
    // no error text at all — the credential in that message cannot reach a log through this path.
    expect(heartbeat[0]).not.toContain("postgres://");
    expect(heartbeat[0]).not.toContain("pw@host");
  });
  // THE LOAD-BEARING CASE. The crons fail by RETURNING NULL, not by throwing, so `absorb` must pass
  // that value through. Without this, the suite stays green even if absorb does `await run()` and
  // discards the result — and every real failure grades as healthy.
  it("reports failure when a cron returns null WITHOUT throwing", async () => {
    const lines = captureAllLogs();
    const units: Promise<unknown>[] = [];
    dispatchAuthScheduled({ scheduledTime: Date.UTC(2026, 0, 1, 12) }, {}, (p) => units.push(p), {
      notificationDrain: async () => null,
      expirySweep: async () => null,
    });
    await Promise.all(units);
    expect(
      lines.filter((l) => l.includes("notification-drain cron reported failure")),
    ).toHaveLength(1);
  });

  it("reports failure when the expiry sweep returns null, at the hour it actually runs", async () => {
    const lines = captureAllLogs();
    const units: Promise<unknown>[] = [];
    dispatchAuthScheduled(
      { scheduledTime: Date.UTC(2026, 0, 1, EXPIRY_SWEEP_UTC_HOUR) },
      {},
      (p) => units.push(p),
      { notificationDrain: async () => ({ sent: 1 }), expirySweep: async () => null },
    );
    await Promise.all(units);
    expect(lines.filter((l) => l.includes("auth-expiry-sweep cron reported failure"))).toHaveLength(
      1,
    );
  });

  it("reports NO failure when both crons return a real result", async () => {
    const lines = captureAllLogs();
    const units: Promise<unknown>[] = [];
    dispatchAuthScheduled(
      { scheduledTime: Date.UTC(2026, 0, 1, EXPIRY_SWEEP_UTC_HOUR) },
      {},
      (p) => units.push(p),
      {
        notificationDrain: async () => ({ sent: 0 }),
        expirySweep: async () => ({ refreshTokens: 0, sessionExchanges: 0 }),
      },
    );
    await Promise.all(units);
    expect(lines.filter((l) => l.includes("reported failure"))).toHaveLength(0);
  });
});
