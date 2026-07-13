import { describe, expect, it } from "vitest";

import { deriveAttention, type AttentionInput } from "./dashboard-attention";

const NONE: AttentionInput = {
  slug: "acme",
  pastDue: false,
  paused: false,
  disabledDestinationCount: 0,
  deadCount: 0,
};

describe("deriveAttention", () => {
  it("returns nothing when all is well (no panel renders)", () => {
    expect(deriveAttention(NONE)).toEqual([]);
  });

  it("orders by severity: past due → paused → disabled destinations → dead deliveries", () => {
    const items = deriveAttention({
      slug: "acme",
      pastDue: true,
      paused: true,
      disabledDestinationCount: 2,
      deadCount: 5,
    });
    expect(items.map((i) => i.kind)).toEqual([
      "past_due",
      "paused",
      "disabled_destinations",
      "dead_deliveries",
    ]);
  });

  it("pluralizes destination and delivery copy on count", () => {
    const one = deriveAttention({ ...NONE, disabledDestinationCount: 1, deadCount: 1 });
    expect(one.find((i) => i.kind === "disabled_destinations")?.title).toBe(
      "1 destination auto-disabled",
    );
    expect(one.find((i) => i.kind === "dead_deliveries")?.title).toBe("1 delivery gave up");

    const many = deriveAttention({ ...NONE, disabledDestinationCount: 3, deadCount: 4 });
    expect(many.find((i) => i.kind === "disabled_destinations")?.title).toBe(
      "3 destinations auto-disabled",
    );
    expect(many.find((i) => i.kind === "dead_deliveries")?.title).toBe("4 deliveries gave up");
  });

  it("each item links to the page that resolves it, with a tone", () => {
    const items = deriveAttention({
      slug: "acme",
      pastDue: true,
      paused: true,
      disabledDestinationCount: 1,
      deadCount: 1,
    });
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(byKind.past_due).toMatchObject({ href: "/org/acme/billing", tone: "danger" });
    expect(byKind.paused).toMatchObject({ href: "/org/acme/usage", tone: "warn" });
    expect(byKind.disabled_destinations).toMatchObject({
      href: "/org/acme/destinations",
      tone: "danger",
    });
    expect(byKind.dead_deliveries).toMatchObject({
      href: "/org/acme/deliveries?status=dead",
      tone: "warn",
    });
  });

  it("shows only the signals that are firing", () => {
    expect(deriveAttention({ ...NONE, paused: true }).map((i) => i.kind)).toEqual(["paused"]);
    expect(deriveAttention({ ...NONE, deadCount: 2 }).map((i) => i.kind)).toEqual([
      "dead_deliveries",
    ]);
  });
});
