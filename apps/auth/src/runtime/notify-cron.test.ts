import type { PendingNotification } from "@webhook-co/db";
import { describe, expect, it } from "vitest";

import { drainNotifications, type NotificationDrainDeps } from "./notify-cron";

const CTX = {
  destinationUrl: "https://api.acme.com/in",
  failureCount: 20,
  lastError: "Bad Gateway",
  lastStatusCode: 502,
};

let seq = 0;
function pending(over: Partial<PendingNotification> = {}): PendingNotification {
  seq += 1;
  return {
    intentId: `intent-${seq}`,
    orgId: "org-1",
    kind: "destination_disabled",
    destinationId: "dest-1",
    ownerEmails: ["owner@example.test"],
    context: CTX,
    createdAt: new Date("2026-07-01T14:32:00Z"),
    ...over,
  };
}

/** Deps that claim everything by default and record every per-owner send + event. */
function deps(
  list: PendingNotification[],
  over: Partial<NotificationDrainDeps> = {},
): { deps: NotificationDrainDeps; events: string[]; sends: string[] } {
  const events: string[] = [];
  const sends: string[] = [];
  return {
    events,
    sends,
    deps: {
      listPending: async () => list,
      claim: async (id) => {
        events.push(`claim:${id}`);
        return true;
      },
      send: async (to) => {
        events.push(`send:${to}`);
        sends.push(to);
      },
      ...over,
    },
  };
}

describe("drainNotifications", () => {
  it("claims then sends ONE email per owner (never a shared To header)", async () => {
    const p = pending({ ownerEmails: ["a@x.test", "b@x.test"] });
    const { deps: d, events, sends } = deps([p]);
    const res = await drainNotifications(d);
    expect(res).toMatchObject({ claimed: 1, sent: 2, failed: 0, skipped: 0 });
    expect(sends).toEqual(["a@x.test", "b@x.test"]); // one send each, not one send to both
    // claim strictly precedes every send (at-most-once ordering)
    expect(events).toEqual([`claim:${p.intentId}`, "send:a@x.test", "send:b@x.test"]);
  });

  it("does NOT send when the claim is lost to another drain", async () => {
    const { deps: d, sends } = deps([pending()], { claim: async () => false });
    const res = await drainNotifications(d);
    expect(res).toMatchObject({ claimed: 0, sent: 0, skipped: 0 });
    expect(sends).toEqual([]);
  });

  it("still emails a context-less intent (graceful degrade — never a silent drop)", async () => {
    const { deps: d, sends } = deps([pending({ context: null })]);
    const res = await drainNotifications(d);
    expect(res).toMatchObject({ claimed: 1, sent: 1, skipped: 0 });
    expect(sends).toEqual(["owner@example.test"]);
  });

  it("claims but does NOT send an ownerless intent (clears it without emailing)", async () => {
    const { deps: d, sends } = deps([pending({ ownerEmails: [] })]);
    const res = await drainNotifications(d);
    expect(res).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(sends).toEqual([]);
  });

  it("claims but does NOT send an unknown kind", async () => {
    const { deps: d, sends } = deps([pending({ kind: "some_future_kind" })]);
    const res = await drainNotifications(d);
    expect(res).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(sends).toEqual([]);
  });

  it("counts a per-owner send failure and continues (no throw, at-most-once)", async () => {
    const p1 = pending({ ownerEmails: ["boom@x.test", "ok@x.test"] });
    const p2 = pending({ ownerEmails: ["next@x.test"] });
    const sends: string[] = [];
    const res = await drainNotifications({
      listPending: async () => [p1, p2],
      claim: async () => true,
      send: async (to) => {
        if (to === "boom@x.test") throw new Error("resend 500");
        sends.push(to);
      },
    });
    expect(res).toMatchObject({ claimed: 2, sent: 2, failed: 1 });
    // boom failed but ok + next still sent; nothing retried.
    expect(sends).toEqual(["ok@x.test", "next@x.test"]);
  });
});
