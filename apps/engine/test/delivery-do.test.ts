import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { DeliveryDO } from "../src/delivery-do";

// The DeliveryDO SHELL in the real workerd runtime: wake()'s binding+alarm plumbing and the FAIL-SAFE alarm
// (never throws; re-arms for the soonest next-due via drainOnce's return). The drain DECISION logic is tested
// purely in delivery-drain.test.ts; here the protected drainOnce seam is overridden so the shell runs with no
// Postgres/R2/KMS. Everything runs INSIDE a runInDurableObject block, invoking wake()/alarm() directly: a
// setAlarm(now) auto-fires in the pool, so injecting a benign seam first keeps that auto-fire from dialing
// the absent DB (the documented listen-session gotcha), and direct invocation is deterministic.

interface Bindings {
  DELIVERY_DO: DurableObjectNamespace<DeliveryDO>;
}
const stubFor = (name: string) => {
  const ns = (env as unknown as Bindings).DELIVERY_DO;
  return ns.get(ns.idFromName(name));
};

// drainOnce now returns the next-due Date (or null) and is the only injected seam.
interface Shell {
  drainOnce: (orgId: string, destinationId: string) => Promise<Date | null>;
  wake: (orgId: string, destinationId: string) => Promise<void>;
  alarm: () => Promise<void>;
}
const ORG = "11111111-1111-4111-8111-111111111111";

describe("DeliveryDO — wake()", () => {
  it("pins the (org, destination) binding and arms an alarm; is idempotent", async () => {
    await runInDurableObject(stubFor("dest-wake"), async (inst, state) => {
      const s = inst as unknown as Shell;
      s.drainOnce = async () => null; // benign seam so the auto-fired alarm never touches the DB

      await s.wake(ORG, "dest-wake");
      expect(await state.storage.get("binding")).toEqual({
        orgId: ORG,
        destinationId: "dest-wake",
      });
      expect(await state.storage.getAlarm()).not.toBeNull(); // wake armed it

      // A SECOND wake for the SAME org is idempotent: the binding is not rewritten, and it still re-arms.
      await s.wake(ORG, "dest-wake");
      expect((await state.storage.get<{ orgId: string }>("binding"))!.orgId).toBe(ORG);
    });
  });

  // S.7 — the TOFU binding guard, mirroring ListenSession's session-pinning (listen-session.ts:162-166).
  // A DeliveryDO is keyed by destinationId only (idFromName(destinationId)), and pins its org on first wake.
  // Without a guard, a wake() carrying a DIFFERENT org for an already-bound destination was accepted and
  // SILENTLY IGNORED — it just re-armed the alarm under the FIRST org's binding. So whoever won the first-wake
  // race owned the DO, and the rightful org's deliveries drained under the wrong org's RLS (which sees none of
  // their rows) → they wedge, durably owed but never sent. It is a liveness/defense-in-depth gap (RLS
  // downstream prevents a cross-org read), and the fix is the same as ListenSession's: refuse the mismatch.
  it("REFUSES a wake that rebinds the destination to a different org, and does not re-arm on it", async () => {
    await runInDurableObject(stubFor("dest-guard"), async (inst, state) => {
      const s = inst as unknown as Shell;
      s.drainOnce = async () => null;

      await s.wake(ORG, "dest-guard"); // first wake pins (ORG, dest-guard)
      await state.storage.deleteAlarm(); // clear so we can prove a rejected wake does NOT re-arm

      await expect(s.wake("22222222-2222-4222-8222-222222222222", "dest-guard")).rejects.toThrow(
        /binding mismatch/i,
      );
      // The binding is untouched and the rejected wake armed nothing.
      expect((await state.storage.get<{ orgId: string }>("binding"))!.orgId).toBe(ORG);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("REFUSES a wake whose destinationId does not match the bound one (defense in depth)", async () => {
    await runInDurableObject(stubFor("dest-x"), async (inst, state) => {
      const s = inst as unknown as Shell;
      s.drainOnce = async () => null;
      await s.wake(ORG, "dest-x");
      // Same DO (same name), but a wake asserting a different destinationId must be refused, never served.
      await expect(s.wake(ORG, "dest-y")).rejects.toThrow(/binding mismatch/i);
      expect((await state.storage.get<{ destinationId: string }>("binding"))!.destinationId).toBe(
        "dest-x",
      );
    });
  });

  it("pulls an existing far-future alarm earlier (a new delivery is due now, not after a backoff)", async () => {
    await runInDurableObject(stubFor("dest-pull"), async (inst, state) => {
      const s = inst as unknown as Shell;
      s.drainOnce = async () => null;
      const far = Date.now() + 10 * 60 * 60 * 1000; // a 10h retry backoff already scheduled
      await state.storage.setAlarm(far);

      await s.wake(ORG, "dest-pull");
      const at = await state.storage.getAlarm();
      expect(at).not.toBeNull();
      expect(at!).toBeLessThan(far); // pulled to ~now, not left 10h out
    });
  });
});

describe("DeliveryDO — fail-safe alarm", () => {
  it("re-arms for the next-due the drain returns", async () => {
    const due = new Date(Date.now() + 60_000);
    await runInDurableObject(stubFor("dest-rearm"), async (inst, state) => {
      const s = inst as unknown as Shell;
      await state.storage.put("binding", { orgId: ORG, destinationId: "dest-rearm" });
      s.drainOnce = async () => due;
      await s.alarm();
      expect(await state.storage.getAlarm()).toBe(due.getTime());
    });
  });

  it("clears the alarm (idle) when the drain reports nothing open", async () => {
    await runInDurableObject(stubFor("dest-idle"), async (inst, state) => {
      const s = inst as unknown as Shell;
      await state.storage.put("binding", { orgId: ORG, destinationId: "dest-idle" });
      s.drainOnce = async () => null;
      await s.alarm();
      expect(await state.storage.getAlarm()).toBeNull(); // idle until a future wake()
    });
  });

  it("does NOT throw when the drain fails, and re-arms near-term (never goes dark)", async () => {
    await runInDurableObject(stubFor("dest-failsafe"), async (inst, state) => {
      const s = inst as unknown as Shell;
      await state.storage.put("binding", { orgId: ORG, destinationId: "dest-failsafe" });
      s.drainOnce = async () => {
        throw new Error("neon unavailable");
      };
      const before = Date.now();
      await expect(s.alarm()).resolves.toBeUndefined(); // fail-safe: a drain error never escapes
      const at = await state.storage.getAlarm();
      expect(at).not.toBeNull();
      // pinned near the ~30s fallback: NOT dark (10h) and NOT a hot-loop (now) — both would pass a bare `> before`.
      expect(at!).toBeGreaterThanOrEqual(before + 29_000);
      expect(at!).toBeLessThan(before + 32_000);
    });
  });

  it("the race-guard takes precedence even over a far-future next-due (the raced delivery isn't stranded)", async () => {
    await runInDurableObject(stubFor("dest-race-far"), async (inst, state) => {
      const s = inst as unknown as Shell;
      await state.storage.put("binding", { orgId: ORG, destinationId: "dest-race-far" });
      const far = Date.now() + 10 * 60 * 60 * 1000;
      // a wake races mid-drain AND the drain returns a far-future next-due; the race must win → fire ~now.
      s.drainOnce = async () => {
        await s.wake(ORG, "dest-race-far");
        return new Date(far);
      };
      const before = Date.now();
      await s.alarm();
      const at = await state.storage.getAlarm();
      expect(at!).toBeLessThan(before + 5_000); // ~now, not 10h out
    });
  });

  it("a wake() that races the drain re-arms now() instead of clearing the alarm (no stranded delivery)", async () => {
    await runInDurableObject(stubFor("dest-race"), async (inst, state) => {
      const s = inst as unknown as Shell;
      await state.storage.put("binding", { orgId: ORG, destinationId: "dest-race" });
      // The drain sees nothing open and would normally deleteAlarm — but a producer enqueues + wakes mid-drain.
      s.drainOnce = async () => {
        await s.wake(ORG, "dest-race");
        return null;
      };
      await s.alarm();
      expect(await state.storage.getAlarm()).not.toBeNull(); // wake's alarm survived — the delivery is not lost
    });
  });

  it("is a no-op with no binding (an alarm before any wake)", async () => {
    await runInDurableObject(stubFor("dest-unbound"), async (inst, state) => {
      let drained = false;
      const s = inst as unknown as Shell;
      s.drainOnce = async () => {
        drained = true;
        return null;
      };
      await s.alarm(); // no binding → returns before any drain or arm
      expect(drained).toBe(false);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
