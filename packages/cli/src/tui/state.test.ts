import type { EventSummary } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import {
  appendEvent,
  initialState,
  MAX_EVENTS,
  moveSelection,
  selectedEvent,
  setStatus,
  toggleDetail,
  visibleWindow,
} from "./state.js";

/** A minimal valid EventSummary fixture — the TUI state only holds + indexes these, never validates. */
function evt(id: string, over: Partial<EventSummary> = {}): EventSummary {
  return {
    id,
    orgId: "00000000-0000-0000-0000-000000000000",
    endpointId: "00000000-0000-0000-0000-000000000001",
    receivedAt: new Date("2026-06-23T00:00:00.000Z"),
    provider: "stripe",
    dedupKey: `dk-${id}`,
    dedupStrategy: "header",
    verified: true,
    ...over,
  };
}

describe("initialState", () => {
  it("starts empty with the first row selected and the given viewport height", () => {
    const s = initialState(10);
    expect(s.events).toEqual([]);
    expect(s.selected).toBe(0);
    expect(s.detail).toBe(false);
    expect(s.viewportRows).toBe(10);
    expect(s.status).toBeNull();
  });
});

describe("appendEvent", () => {
  it("appends in arrival order and leaves an existing selection put (no auto-jump)", () => {
    let s = initialState(10);
    s = appendEvent(s, evt("a"));
    s = appendEvent(s, evt("b"));
    s = appendEvent(s, evt("c"));
    expect(s.events.map((e) => e.id)).toEqual(["a", "b", "c"]);
    // selection stays at 0 — appends don't yank the user off the row they're inspecting.
    expect(s.selected).toBe(0);
  });

  it("is immutable — returns a new state, leaves the prior one untouched", () => {
    const s0 = initialState(10);
    const s1 = appendEvent(s0, evt("a"));
    expect(s0.events).toEqual([]);
    expect(s1.events).toHaveLength(1);
    expect(s1).not.toBe(s0);
  });

  it("caps the retained list at MAX_EVENTS, dropping oldest (bounded memory like the plain tail)", () => {
    let s = initialState(10);
    for (let i = 0; i < MAX_EVENTS + 3; i++) s = appendEvent(s, evt(`e${i}`));
    expect(s.events).toHaveLength(MAX_EVENTS);
    // the three oldest were dropped — the window now starts at e3.
    expect(s.events[0]!.id).toBe("e3");
    expect(s.events[s.events.length - 1]!.id).toBe(`e${MAX_EVENTS + 2}`);
  });

  it("shifts the selection to track its event when oldest rows are dropped", () => {
    let s = initialState(10);
    for (let i = 0; i < MAX_EVENTS; i++) s = appendEvent(s, evt(`e${i}`)); // exactly full
    s = moveSelection(s, 5); // select e5 (index 5)
    expect(selectedEvent(s)?.id).toBe("e5");
    s = appendEvent(s, evt("overflow")); // drops e0 → selection shifts to keep e5 under the cursor
    expect(selectedEvent(s)?.id).toBe("e5");
    expect(s.selected).toBe(4);
  });
});

describe("moveSelection", () => {
  it("moves up/down and clamps to the event bounds", () => {
    let s = initialState(10);
    for (const id of ["a", "b", "c"]) s = appendEvent(s, evt(id));
    s = moveSelection(s, 1); // 0 → 1
    expect(s.selected).toBe(1);
    s = moveSelection(s, 1); // 1 → 2
    s = moveSelection(s, 1); // clamp at 2 (last)
    expect(s.selected).toBe(2);
    s = moveSelection(s, -1); // 2 → 1
    s = moveSelection(s, -5); // clamp at 0
    expect(s.selected).toBe(0);
  });

  it("stays at 0 when there are no events", () => {
    const s = moveSelection(initialState(10), 1);
    expect(s.selected).toBe(0);
  });
});

describe("toggleDetail", () => {
  it("flips the detail flag", () => {
    let s = initialState(10);
    expect(s.detail).toBe(false);
    s = toggleDetail(s);
    expect(s.detail).toBe(true);
    s = toggleDetail(s);
    expect(s.detail).toBe(false);
  });
});

describe("setStatus", () => {
  it("sets and clears the transient status line", () => {
    let s = setStatus(initialState(10), "replaying…");
    expect(s.status).toBe("replaying…");
    s = setStatus(s, null);
    expect(s.status).toBeNull();
  });
});

describe("selectedEvent", () => {
  it("returns the event at the selection, or undefined when empty", () => {
    let s = initialState(10);
    expect(selectedEvent(s)).toBeUndefined();
    s = appendEvent(s, evt("a"));
    s = appendEvent(s, evt("b"));
    s = moveSelection(s, 1);
    expect(selectedEvent(s)?.id).toBe("b");
  });
});

describe("visibleWindow", () => {
  it("returns every event when they fit the viewport (offset 0)", () => {
    let s = initialState(5);
    for (const id of ["a", "b", "c"]) s = appendEvent(s, evt(id));
    const w = visibleWindow(s);
    expect(w.offset).toBe(0);
    expect(w.items.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("scrolls so the selected row stays visible (anchored to the bottom edge)", () => {
    let s = initialState(3); // only 3 rows fit
    for (const id of ["a", "b", "c", "d", "e"]) s = appendEvent(s, evt(id)); // 5 events
    // selection at 0 → top window
    expect(visibleWindow(s).items.map((e) => e.id)).toEqual(["a", "b", "c"]);
    // move to the last (index 4) → window slides to the bottom three
    for (let i = 0; i < 4; i++) s = moveSelection(s, 1);
    const w = visibleWindow(s);
    expect(w.offset).toBe(2);
    expect(w.items.map((e) => e.id)).toEqual(["c", "d", "e"]);
  });

  it("keeps a mid-list selection inside the window", () => {
    let s = initialState(3);
    for (const id of ["a", "b", "c", "d", "e"]) s = appendEvent(s, evt(id));
    for (let i = 0; i < 3; i++) s = moveSelection(s, 1); // select index 3 ("d")
    const w = visibleWindow(s);
    expect(w.items.map((e) => e.id)).toContain("d");
    expect(w.items).toHaveLength(3);
  });
});
