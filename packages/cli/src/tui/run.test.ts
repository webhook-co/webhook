import type { EventSummary } from "@webhook-co/shared";
import { describe, expect, it, vi } from "vitest";

import { createTui, type TuiEffects, type TuiInputHandlers, type TuiTerminal } from "./run.js";

function evt(id: string, over: Partial<EventSummary> = {}): EventSummary {
  return {
    id,
    orgId: "00000000-0000-0000-0000-000000000000",
    endpointId: "00000000-0000-0000-0000-000000000001",
    receivedAt: new Date("2026-06-23T12:34:56.000Z"),
    provider: "stripe",
    dedupKey: `dk-${id}`,
    dedupStrategy: "header",
    verified: true,
    ...over,
  };
}

function fakeTerminal(rows = 24, columns = 80) {
  const writes: string[] = [];
  let handlers: TuiInputHandlers | undefined;
  const closed = vi.fn();
  const term: TuiTerminal = {
    write: (s) => void writes.push(s),
    size: () => ({ columns, rows }),
    start: (h) => {
      handlers = h;
      return { close: closed };
    },
  };
  return {
    term,
    writes,
    closed,
    last: () => writes.join(""),
    key: (chunk: string) => handlers?.onKey(chunk),
    resize: () => handlers?.onResize(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function effects(over: Partial<TuiEffects> = {}): TuiEffects {
  return {
    dashboardUrl: (e) => `https://app.webhook.co/events/${e.id}`,
    openBrowser: vi.fn(async () => {}),
    ...over,
  };
}

describe("createTui", () => {
  it("enters the alt-screen and draws an initial frame on start", () => {
    const t = fakeTerminal();
    createTui({ terminal: t.term, effects: effects(), color: false });
    expect(t.last()).toContain("\x1b[?1049h"); // enter alt-screen
    expect(t.last()).toContain("\x1b[?25l"); // hide cursor
    expect(t.last().toLowerCase()).toContain("waiting"); // the empty-state frame
  });

  it("restores the terminal and re-throws if the initial render fails (no raw-mode leak)", () => {
    const closed = vi.fn();
    let calls = 0;
    const term: TuiTerminal = {
      write: () => {
        calls += 1;
        throw new Error("EPIPE"); // stdout broke as the TUI started
      },
      size: () => ({ columns: 80, rows: 24 }),
      start: () => ({ close: closed }),
    };
    expect(() => createTui({ terminal: term, effects: effects(), color: false })).toThrow("EPIPE");
    expect(closed).toHaveBeenCalled(); // raw input torn down (cooked mode restored)
    expect(calls).toBeGreaterThan(0);
  });

  it("renders a pushed event into the list", () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false });
    tui.pushEvent(evt("evt-pushed"));
    expect(t.last()).toContain("evt-pushed");
  });

  it("navigates the selection with the arrow keys", () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false });
    tui.pushEvent(evt("aaa"));
    tui.pushEvent(evt("bbb"));
    t.key("\x1b[B"); // down → select bbb
    const frame = t.writes[t.writes.length - 1]!;
    const bbbRow = frame.split("\n").find((l) => l.includes("bbb"))!;
    expect(bbbRow.trimStart().startsWith("›")).toBe(true);
  });

  it("toggles the detail pane with d", () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false });
    tui.pushEvent(evt("e1", { dedupKey: "idem-xyz" }));
    t.key("d");
    expect(t.writes[t.writes.length - 1]!).toContain("idem-xyz");
  });

  it("opens the selected event in the browser with o", async () => {
    const t = fakeTerminal();
    const open = vi.fn(async () => {});
    const tui = createTui({
      terminal: t.term,
      effects: effects({ openBrowser: open }),
      color: false,
    });
    tui.pushEvent(evt("evt-open"));
    t.key("o");
    await flush();
    expect(open).toHaveBeenCalledWith("https://app.webhook.co/events/evt-open");
  });

  it("replays the selected event with r and shows the result status", async () => {
    const t = fakeTerminal();
    const replay = vi.fn(async () => ({ ok: true, message: "delivered · 200" }));
    const tui = createTui({ terminal: t.term, effects: effects({ replay }), color: false });
    tui.pushEvent(evt("evt-replay"));
    t.key("r");
    await flush();
    expect(replay).toHaveBeenCalledOnce();
    expect(t.last()).toContain("delivered · 200");
  });

  it("tells the user to set --forward when r is pressed with no replay target", () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false }); // no replay effect
    tui.pushEvent(evt("e1"));
    t.key("r");
    expect(t.last().toLowerCase()).toContain("--forward");
  });

  it("ignores a second r while a replay is already in flight", async () => {
    const t = fakeTerminal();
    let resolve!: (v: { ok: boolean; message: string }) => void;
    const replay = vi.fn(() => new Promise<{ ok: boolean; message: string }>((r) => (resolve = r)));
    const tui = createTui({ terminal: t.term, effects: effects({ replay }), color: false });
    tui.pushEvent(evt("e1"));
    t.key("r");
    t.key("r"); // ignored — still in flight
    resolve({ ok: true, message: "done" });
    await flush();
    expect(replay).toHaveBeenCalledOnce();
  });

  it("shows a note in the status line", () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false });
    tui.note("3 events behind — replaying the backlog…");
    expect(t.last()).toContain("3 events behind");
  });

  it("re-renders on resize", () => {
    const t = fakeTerminal();
    createTui({ terminal: t.term, effects: effects(), color: false }); // started for its side effects
    const before = t.writes.length;
    t.resize();
    expect(t.writes.length).toBeGreaterThan(before);
  });

  it("quits on q: resolves finished, restores the terminal, and closes the input", async () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false });
    t.key("q");
    await tui.finished; // resolves
    expect(t.closed).toHaveBeenCalled();
    expect(t.last()).toContain("\x1b[?1049l"); // leave alt-screen
    expect(t.last()).toContain("\x1b[?25h"); // show cursor
  });

  it("quits on Ctrl-C (raw mode delivers it as a key, not a signal)", async () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false });
    t.key("\x03");
    await expect(tui.finished).resolves.toBeUndefined();
  });

  it("stop() resolves finished and is idempotent", async () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false });
    tui.stop();
    tui.stop(); // no throw, no double-close beyond the first
    await expect(tui.finished).resolves.toBeUndefined();
    expect(t.closed).toHaveBeenCalledOnce();
  });

  it("after quit, further pushes/keys are no-ops (no writes to a torn-down terminal)", async () => {
    const t = fakeTerminal();
    const tui = createTui({ terminal: t.term, effects: effects(), color: false });
    t.key("q");
    await tui.finished;
    const after = t.writes.length;
    tui.pushEvent(evt("late"));
    t.key("d");
    expect(t.writes.length).toBe(after);
  });
});
