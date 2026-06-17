import { run } from "@stricli/core";
import { encodeServerFrame, type EventSummary } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { app } from "../app.js";
import type { CredentialStore } from "../config/store.js";
import type { ConnectWebSocket, WsHandlers } from "../context.js";
import { makeTestContext } from "../context.js";
import { CAPABILITY_EXIT, EXIT, normalizeStricliExitCode } from "../output/exit-codes.js";
import { backoffMs, formatListenEvent, runListen, type ListenSince } from "./listen.js";

function loggedInStore(): CredentialStore {
  return {
    get: async () => ({ apiKey: "whk_test" }),
    set: async () => undefined,
    erase: async () => undefined,
    list: async () => ["default"],
    getApiBaseUrl: async () => undefined,
    setApiBaseUrl: async () => undefined,
  };
}

const EP = "11111111-1111-4111-8111-111111111111";
const EV = "33333333-3333-4333-8333-333333333333";

/** Flush pending micro + macro tasks so the loop advances between drives. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function summary(over: Partial<EventSummary> = {}): EventSummary {
  return {
    id: EV,
    orgId: "22222222-2222-4222-8222-222222222222",
    endpointId: EP,
    receivedAt: new Date("2026-06-10T12:00:00.000Z"),
    provider: "stripe",
    dedupKey: "dk_1",
    dedupStrategy: "content_hash",
    verified: true,
    ...over,
  };
}

// A controllable fake tunnel: records connect URLs/headers + sent frames, and exposes the current
// connection's handlers so a test can drive ready/event/error/close synchronously.
function fakeTunnel() {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const sent: string[] = [];
  let handlers: WsHandlers | undefined;
  let closeCount = 0;
  const connect: ConnectWebSocket = (url, opts) => {
    calls.push({ url, headers: { ...opts.headers } });
    handlers = opts.handlers;
    return { send: (d: string) => void sent.push(d), close: () => void (closeCount += 1) };
  };
  return {
    connect,
    calls,
    sent,
    get closeCount() {
      return closeCount;
    },
    h: (): WsHandlers => {
      if (handlers === undefined) throw new Error("no connection yet");
      return handlers;
    },
  };
}

function depsFor(
  t: ReturnType<typeof fakeTunnel>,
  out: { emit: string[]; note: string[] },
  signal: AbortSignal,
  since: ListenSince = { kind: "beginning" },
) {
  return {
    connect: t.connect,
    tunnelUrl: "wss://wbhk.my",
    apiKey: "whk_k",
    endpointId: EP,
    since,
    emit: (l: string) => void out.emit.push(l),
    note: (l: string) => void out.note.push(l),
    format: "text" as const,
    color: false,
    signal,
    sleep: async () => {}, // instant backoff under test
  };
}

describe("backoffMs", () => {
  it("caps the exponential growth and applies full jitter", () => {
    expect(backoffMs(1, () => 0)).toBe(250); // base 500 → half 250 + 0 jitter
    expect(backoffMs(1, () => 1)).toBe(500); // 250 + 250
    expect(backoffMs(50, () => 0)).toBe(15000); // capped at 30000 → half
    expect(backoffMs(50, () => 1)).toBe(30000);
  });
});

describe("formatListenEvent", () => {
  it("renders a compact line: timestamp, provider (— when null), verified word, id", () => {
    const line = formatListenEvent(summary({ provider: null, verified: false }), false);
    expect(line).toContain("2026-06-10T12:00:00.000Z");
    expect(line).toContain("—");
    expect(line).toContain("unverified");
    expect(line).toContain(EV);
  });
});

describe("runListen", () => {
  it("connects with Bearer + endpointId + the first-connect sinceCursor, then prints + acks", async () => {
    const t = fakeTunnel();
    const out = { emit: [] as string[], note: [] as string[] };
    const ac = new AbortController();
    const p = runListen(depsFor(t, out, ac.signal, { kind: "cursor", cursor: "cur0" }));
    await tick();

    expect(t.calls[0]!.headers.authorization).toBe("Bearer whk_k");
    const u0 = new URL(t.calls[0]!.url);
    expect(u0.searchParams.get("endpointId")).toBe(EP);
    expect(u0.searchParams.get("sinceCursor")).toBe("cur0");
    expect(u0.searchParams.get("sessionId")).toBeNull();

    t.h().onOpen();
    t.h().onMessage(
      encodeServerFrame({ type: "ready", sessionId: "sess-1", watermarkDeltaMs: 5000 }),
    );
    t.h().onMessage(encodeServerFrame({ type: "event", summary: summary(), cursor: "c1" }));
    await tick();

    expect(out.emit).toHaveLength(1);
    expect(out.emit[0]).toContain(EV);
    expect(t.sent).toContain(JSON.stringify({ type: "ack", cursor: "c1" }));

    ac.abort();
    await p;
    expect(t.closeCount).toBeGreaterThanOrEqual(1);
  });

  it("maps --since now to ?since=now and --since beginning to neither param", async () => {
    const out = { emit: [] as string[], note: [] as string[] };

    const nowT = fakeTunnel();
    const nowAc = new AbortController();
    const nowP = runListen(depsFor(nowT, out, nowAc.signal, { kind: "now" }));
    await tick();
    const nowUrl = new URL(nowT.calls[0]!.url);
    expect(nowUrl.searchParams.get("since")).toBe("now");
    expect(nowUrl.searchParams.get("sinceCursor")).toBeNull();
    nowAc.abort();
    await nowP;

    const begT = fakeTunnel();
    const begAc = new AbortController();
    const begP = runListen(depsFor(begT, out, begAc.signal, { kind: "beginning" }));
    await tick();
    const begUrl = new URL(begT.calls[0]!.url);
    expect(begUrl.searchParams.get("since")).toBeNull();
    expect(begUrl.searchParams.get("sinceCursor")).toBeNull();
    begAc.abort();
    await begP;
  });

  it("reconnects on a drop, reusing the session id and dropping the seed cursor", async () => {
    const t = fakeTunnel();
    const out = { emit: [] as string[], note: [] as string[] };
    const ac = new AbortController();
    const p = runListen(depsFor(t, out, ac.signal, { kind: "cursor", cursor: "cur0" }));
    await tick();
    t.h().onMessage(
      encodeServerFrame({ type: "ready", sessionId: "sess-1", watermarkDeltaMs: 5000 }),
    );
    t.h().onClose(1006, "dropped");
    await tick();

    expect(t.calls).toHaveLength(2);
    const u1 = new URL(t.calls[1]!.url);
    expect(u1.searchParams.get("sessionId")).toBe("sess-1");
    expect(u1.searchParams.get("sinceCursor")).toBeNull(); // only the FIRST connect carries the seed

    ac.abort();
    await p;
  });

  it("dedups by cursor: a redelivered event prints once but is acked each time", async () => {
    const t = fakeTunnel();
    const out = { emit: [] as string[], note: [] as string[] };
    const ac = new AbortController();
    const p = runListen(depsFor(t, out, ac.signal));
    await tick();
    t.h().onMessage(encodeServerFrame({ type: "ready", sessionId: "s", watermarkDeltaMs: 5000 }));
    const ev = encodeServerFrame({ type: "event", summary: summary(), cursor: "c1" });
    t.h().onMessage(ev);
    t.h().onMessage(ev); // at-least-once redelivery of the same cursor
    await tick();

    expect(out.emit).toHaveLength(1); // printed once
    expect(t.sent.filter((s) => s === JSON.stringify({ type: "ack", cursor: "c1" }))).toHaveLength(
      2,
    );

    ac.abort();
    await p;
  });

  it("treats an error frame as a non-fatal stderr notice and stays connected", async () => {
    const t = fakeTunnel();
    const out = { emit: [] as string[], note: [] as string[] };
    const ac = new AbortController();
    const p = runListen(depsFor(t, out, ac.signal));
    await tick();
    t.h().onMessage(
      encodeServerFrame({ type: "error", code: "POLL_DEGRADED", message: "transient" }),
    );
    await tick();

    expect(out.note.join("")).toContain("POLL_DEGRADED");
    expect(t.calls).toHaveLength(1); // not a reconnect — still the same connection

    ac.abort();
    await p;
  });

  it("emits NDJSON in json mode", async () => {
    const t = fakeTunnel();
    const out = { emit: [] as string[], note: [] as string[] };
    const ac = new AbortController();
    const p = runListen({ ...depsFor(t, out, ac.signal), format: "json" });
    await tick();
    t.h().onMessage(encodeServerFrame({ type: "ready", sessionId: "s", watermarkDeltaMs: 5000 }));
    t.h().onMessage(encodeServerFrame({ type: "event", summary: summary(), cursor: "c1" }));
    await tick();

    const line = out.emit[0]!;
    expect(line.trimEnd()).not.toContain("\n"); // true NDJSON: one event per line, not pretty-printed
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe(EV);
    expect(parsed.verified).toBe(true);

    ac.abort();
    await p;
  });

  it("wakes from the backoff immediately on abort (no hang up to the full backoff)", async () => {
    const t = fakeTunnel();
    const out = { emit: [] as string[], note: [] as string[] };
    const ac = new AbortController();
    // A backoff that never resolves on its own — only the abort can end the wait.
    const neverSleep = (): Promise<void> => new Promise<void>(() => {});
    const p = runListen({ ...depsFor(t, out, ac.signal), sleep: neverSleep });
    await tick();
    t.h().onClose(1006, "drop"); // → enters the (never-resolving) backoff
    await tick();
    expect(t.calls).toHaveLength(1); // still waiting to reconnect

    ac.abort(); // Ctrl+C during the backoff
    await p; // resolves promptly — would hang forever if the backoff ignored the abort
    expect(t.calls).toHaveLength(1); // never reconnected after abort
  });

  it("skips a garbled frame without throwing or reconnecting", async () => {
    const t = fakeTunnel();
    const out = { emit: [] as string[], note: [] as string[] };
    const ac = new AbortController();
    const p = runListen(depsFor(t, out, ac.signal));
    await tick();
    t.h().onMessage("{not json");
    t.h().onMessage(JSON.stringify({ type: "ack", cursor: "x" })); // a client-only frame → ignored
    await tick();

    expect(out.emit).toHaveLength(0);
    expect(t.calls).toHaveLength(1);

    ac.abort();
    await p;
  });

  it("does nothing when the signal is already aborted (the loop guard short-circuits)", async () => {
    const t = fakeTunnel();
    const out = { emit: [] as string[], note: [] as string[] };
    const ac = new AbortController();
    ac.abort();
    await runListen(depsFor(t, out, ac.signal));
    expect(t.calls).toHaveLength(0); // never connects
  });
});

describe("wbhk listen command (wiring)", () => {
  it("requires a credential", async () => {
    const t = makeTestContext({
      store: {
        get: async () => null,
        set: async () => undefined,
        erase: async () => undefined,
        list: async () => [],
        getApiBaseUrl: async () => undefined,
        setApiBaseUrl: async () => undefined,
      },
    });
    await run(app, ["listen", EP], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(CAPABILITY_EXIT.UNAUTHORIZED);
  });

  it("rejects a non-wss --tunnel-url as a usage error (the bearer key rides the upgrade)", async () => {
    const t = makeTestContext({ store: loggedInStore() });
    await run(app, ["listen", EP, "--tunnel-url", "http://evil.example"], t.ctx);
    expect(normalizeStricliExitCode(t.ctx.process.exitCode)).toBe(EXIT.USAGE);
    expect(t.stderr().toLowerCase()).toContain("wss://");
  });
});
