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

  const USAGE_CTX = {
    usage: 8_000,
    eventCap: 10_000,
    threshold: 80,
    pausePolicy: "pause" as const,
    periodEndIso: "2026-08-01T00:00:00.000Z",
  };

  it("routes a usage_threshold intent to the usage renderer and sends it", async () => {
    const subjects: string[] = [];
    const list = [pending({ kind: "usage_threshold", destinationId: null, context: USAGE_CTX })];
    const res = await drainNotifications({
      listPending: async () => list,
      claim: async () => true,
      send: async (_to, email) => void subjects.push(email.subject),
    });
    expect(res).toMatchObject({ claimed: 1, sent: 1, skipped: 0 });
    // The usage renderer's subject (not the destination one) — proves kind-dispatch picked the right renderer.
    expect(subjects).toEqual(["You've used 80% of your included events"]);
  });

  it("claims but does NOT send a usage_threshold intent with no context (unrenderable)", async () => {
    const { deps: d, sends } = deps([
      pending({ kind: "usage_threshold", destinationId: null, context: null }),
    ]);
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

describe("drainNotifications — api_key_revoked (secret-scanning owner alert)", () => {
  const KEY_CTX = {
    keyName: "ci-deploy",
    keyStart: "whk_AbC1234",
    source: "github_secret_scanning" as const,
  };

  it("routes an api_key_revoked intent to the key-revoked renderer and sends it", async () => {
    const p = pending({ kind: "api_key_revoked", destinationId: null, context: KEY_CTX });
    const { deps: d, sends } = deps([p]);
    const r = await drainNotifications(d);
    expect(r).toMatchObject({ claimed: 1, sent: 1, skipped: 0, failed: 0 });
    expect(sends).toEqual(["owner@example.test"]);
  });

  it("claims but does NOT send an api_key_revoked intent with no context (unrenderable)", async () => {
    const p = pending({ kind: "api_key_revoked", destinationId: null, context: null });
    const { deps: d, sends } = deps([p]);
    const r = await drainNotifications(d);
    expect(r).toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
    expect(sends).toEqual([]); // cleared, never left pending to retry-loop
  });

  it("emails every owner of the org exactly once", async () => {
    const p = pending({
      kind: "api_key_revoked",
      destinationId: null,
      context: KEY_CTX,
      ownerEmails: ["a@x.test", "b@x.test"],
    });
    const { deps: d, sends } = deps([p]);
    const r = await drainNotifications(d);
    expect(r).toMatchObject({ claimed: 1, sent: 2 });
    expect(sends).toEqual(["a@x.test", "b@x.test"]);
  });
});

describe("drainNotifications — a render failure must not poison the batch", () => {
  // A truthy-but-malformed usage_threshold context: renderUsageThresholdEmail reaches
  // `ctx.usage.toLocaleString()` and throws a TypeError. This is a real throw, not a contrived one.
  const MALFORMED = { pausePolicy: "pause" } as never;

  it("contains a throwing renderer: that intent is skipped, later intents still send", async () => {
    const bad = pending({ kind: "usage_threshold", destinationId: null, context: MALFORMED });
    const good = pending({ ownerEmails: ["later@x.test"] });
    const { deps: d, sends } = deps([bad, good]);
    const r = await drainNotifications(d);
    // The batch survives: the healthy intent queued behind the bad one still got its email.
    expect(sends).toEqual(["later@x.test"]);
    expect(r.claimed).toBe(2);
    expect(r.sent).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("never rejects even when the only intent's renderer throws", async () => {
    const bad = pending({ kind: "usage_threshold", destinationId: null, context: MALFORMED });
    const { deps: d } = deps([bad]);
    await expect(drainNotifications(d)).resolves.toMatchObject({ claimed: 1, sent: 0, skipped: 1 });
  });
});
