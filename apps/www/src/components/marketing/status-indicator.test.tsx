import { describe, expect, it, vi } from "vitest";

import { fetchStatus, safeColor, safeMessage } from "./status-indicator";

const ok = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe("safeColor", () => {
  // The colour is chosen by a third party and lands in a style attribute, so it is matched, never
  // interpolated. A vendor must not be able to put arbitrary text into our CSS.
  it("accepts hex colours in the shapes shields uses", () => {
    for (const c of ["#16a34a", "#fff", "#16a34aff"]) expect(safeColor(c)).toBe(c);
  });

  it.each([
    ["a css function", "rgb(1,2,3)"],
    ["a css keyword", "red"],
    ["an injection attempt", "#fff;background:url(https://evil.test/x)"],
    ["an expression", "expression(alert(1))"],
    ["a non-string", 42],
    ["empty", ""],
  ])("falls back to currentColor for %s", (_l, value) => {
    expect(safeColor(value)).toBe("currentColor");
  });
});

describe("safeMessage", () => {
  it("keeps a normal label", () => {
    expect(safeMessage("Operational")).toBe("Operational");
  });

  // A vendor string must not be able to reflow the footer.
  it.each([
    ["overlong", "x".repeat(41)],
    ["blank", "   "],
    ["a non-string", { a: 1 }],
  ])("rejects %s", (_l, value) => {
    expect(safeMessage(value)).toBeNull();
  });
});

describe("fetchStatus", () => {
  it("returns the live status", async () => {
    const s = await fetchStatus(ok({ message: "Operational", color: "#16a34a" }));
    expect(s).toEqual({ message: "Operational", color: "#16a34a" });
  });

  // Every one of these must render NOTHING rather than a stale or wrong claim of health.
  it("returns null when the vendor is unreachable", async () => {
    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await fetchStatus(boom)).toBeNull();
  });

  it("returns null on a non-2xx", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await fetchStatus(bad)).toBeNull();
  });

  it("returns null on non-JSON", async () => {
    const junk = vi.fn(
      async () => new Response("<html>", { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await fetchStatus(junk)).toBeNull();
  });

  it.each([
    ["an empty object", {}],
    ["a null body", null],
    ["a missing message", { color: "#16a34a" }],
    ["an overlong message", { message: "x".repeat(41), color: "#16a34a" }],
  ])("returns null for %s", async (_l, body) => {
    expect(await fetchStatus(ok(body))).toBeNull();
  });

  // A hostile colour must degrade the DOT, not suppress a real status or reach CSS.
  it("keeps the status but neutralises an unsafe colour", async () => {
    const s = await fetchStatus(ok({ message: "Degraded", color: "url(javascript:alert(1))" }));
    expect(s).toEqual({ message: "Degraded", color: "currentColor" });
  });

  it("bounds the request so a hung vendor cannot stall the page", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ message: "Operational" })));
    await fetchStatus(spy as unknown as typeof fetch);
    expect((spy.mock.calls[0]?.[1] as RequestInit).signal).toBeDefined();
  });
});
