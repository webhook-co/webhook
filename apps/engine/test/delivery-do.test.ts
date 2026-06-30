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

      await s.wake("other-org", "dest-wake"); // idempotent: binding not overwritten
      expect((await state.storage.get<{ orgId: string }>("binding"))!.orgId).toBe(ORG);
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
      expect(at!).toBeGreaterThan(before); // a near-term fallback, not dark
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
