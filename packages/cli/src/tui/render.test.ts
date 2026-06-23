import type { EventSummary } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { stripAnsi } from "../output/color.js";
import { appendEvent, initialState, moveSelection, setStatus, toggleDetail } from "./state.js";
import { fitWidth, renderFrame } from "./render.js";

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

const opts = { color: false, columns: 80 };

describe("renderFrame", () => {
  it("shows a waiting placeholder and the key hints when there are no events", () => {
    const frame = renderFrame(initialState(10), opts);
    expect(frame.toLowerCase()).toContain("waiting");
    expect(frame).toContain("quit");
    expect(frame).toContain("replay");
  });

  it("marks only the selected row and lists every visible event id", () => {
    let s = initialState(10);
    for (const id of ["aaa", "bbb", "ccc"]) s = appendEvent(s, evt(id));
    s = moveSelection(s, 1); // select "bbb"
    const lines = renderFrame(s, opts).split("\n");
    const rowFor = (id: string) => lines.find((l) => l.includes(id))!;
    expect(rowFor("bbb").trimStart().startsWith("›")).toBe(true); // selection marker
    expect(rowFor("aaa").startsWith("›")).toBe(false);
    expect(rowFor("ccc").startsWith("›")).toBe(false);
    for (const id of ["aaa", "bbb", "ccc"]) expect(renderFrame(s, opts)).toContain(id);
  });

  it("renders a detail pane for the selected event when detail is open", () => {
    let s = initialState(10);
    s = appendEvent(s, evt("evt-1", { dedupKey: "idem-key-xyz", provider: "github" }));
    const closed = renderFrame(s, opts);
    expect(closed).not.toContain("idem-key-xyz");
    s = toggleDetail(s);
    const open = renderFrame(s, opts);
    expect(open).toContain("idem-key-xyz");
    expect(open).toContain("github");
  });

  it("shows the transient status line when set", () => {
    let s = appendEvent(initialState(10), evt("e1"));
    s = setStatus(s, "delivered · 200");
    expect(renderFrame(s, opts)).toContain("delivered · 200");
  });

  it("colorizes the verified token only when color is enabled", () => {
    const s = appendEvent(initialState(10), evt("e1", { verified: false }));
    expect(renderFrame(s, { color: false, columns: 80 })).not.toContain("\x1b[");
    expect(renderFrame(s, { color: true, columns: 80 })).toContain("\x1b[");
  });

  it("never emits a visible line wider than the terminal", () => {
    let s = initialState(10);
    s = appendEvent(
      s,
      evt("an-extremely-long-event-identifier-that-would-overflow-a-narrow-terminal"),
    );
    s = toggleDetail(s);
    for (const line of renderFrame(s, { color: true, columns: 40 }).split("\n")) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
    }
  });
});

describe("fitWidth (surrogate-safe truncation)", () => {
  // "ab💥cd": a(0) b(1) [high(2) low(3) = 💥] c(4) d(5)
  it("drops an incomplete astral char rather than leave a lone surrogate", () => {
    const out = fitWidth("ab💥cd", 3); // cut at 3 lands between the surrogate pair
    expect(out).toBe("ab");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false); // no lone high surrogate
  });
  it("keeps a whole surrogate pair when it fits", () => {
    expect(fitWidth("ab💥cd", 4)).toBe("ab💥");
  });
  it("returns the line unchanged when within the width", () => {
    expect(fitWidth("abc", 10)).toBe("abc");
  });
});
