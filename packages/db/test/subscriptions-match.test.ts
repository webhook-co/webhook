import { describe, expect, it } from "vitest";

import {
  matchSubscription,
  type MatchableEvent,
  type SubscriptionSelector,
} from "../src/subscriptions";

// The PURE Tier-3 subscription matcher (S3 Slice 3 PR2). An event delivers to an enabled subscription iff
// ALL axes hold (AND-combined): provider (null = any), event_types (exact / trailing-glob `x.*` / `*`;
// a null event_type only matches `*`), require_verified, and enabled. Matching is set/glob math over fields
// WE control — never a deep walk of untrusted JSON. Exhaustively unit-tested here (no Postgres).

const event = (over: Partial<MatchableEvent> = {}): MatchableEvent => ({
  provider: over.provider ?? "stripe",
  eventType: over.eventType === undefined ? "charge.succeeded" : over.eventType,
  verified: over.verified ?? true,
});
const sub = (over: Partial<SubscriptionSelector> = {}): SubscriptionSelector => ({
  provider: over.provider === undefined ? null : over.provider,
  eventTypes: over.eventTypes ?? ["*"],
  requireVerified: over.requireVerified ?? false,
  enabled: over.enabled ?? true,
});

describe("matchSubscription — zero-config default (match-all-from-this-endpoint)", () => {
  it("the default subscription (provider null, ['*'], requireVerified false) matches any event", () => {
    expect(matchSubscription(event(), sub())).toBe(true);
    expect(
      matchSubscription(event({ provider: "github", eventType: null, verified: false }), sub()),
    ).toBe(true);
  });
});

describe("matchSubscription — provider axis", () => {
  it("null provider matches any; a set provider matches only that provider", () => {
    expect(matchSubscription(event({ provider: "stripe" }), sub({ provider: null }))).toBe(true);
    expect(matchSubscription(event({ provider: "stripe" }), sub({ provider: "stripe" }))).toBe(
      true,
    );
    expect(matchSubscription(event({ provider: "github" }), sub({ provider: "stripe" }))).toBe(
      false,
    );
  });
});

describe("matchSubscription — event_types axis (exact / trailing-glob / star)", () => {
  it("'*' matches anything, including a null (unextracted) event_type", () => {
    expect(matchSubscription(event({ eventType: "anything" }), sub({ eventTypes: ["*"] }))).toBe(
      true,
    );
    expect(matchSubscription(event({ eventType: null }), sub({ eventTypes: ["*"] }))).toBe(true);
  });

  it("an exact event_type matches only itself", () => {
    expect(
      matchSubscription(
        event({ eventType: "charge.succeeded" }),
        sub({ eventTypes: ["charge.succeeded"] }),
      ),
    ).toBe(true);
    expect(
      matchSubscription(
        event({ eventType: "charge.failed" }),
        sub({ eventTypes: ["charge.succeeded"] }),
      ),
    ).toBe(false);
  });

  it("a trailing glob 'charge.*' matches every type under 'charge.' but not a sibling prefix", () => {
    const s = sub({ eventTypes: ["charge.*"] });
    expect(matchSubscription(event({ eventType: "charge.succeeded" }), s)).toBe(true);
    expect(matchSubscription(event({ eventType: "charge.refunded" }), s)).toBe(true);
    expect(matchSubscription(event({ eventType: "invoice.paid" }), s)).toBe(false);
    expect(matchSubscription(event({ eventType: "charge" }), s)).toBe(false); // no dotted child
  });

  it("a null event_type matches ONLY '*' — never an exact or trailing-glob pattern", () => {
    expect(matchSubscription(event({ eventType: null }), sub({ eventTypes: ["charge.*"] }))).toBe(
      false,
    );
    expect(
      matchSubscription(event({ eventType: null }), sub({ eventTypes: ["charge.succeeded"] })),
    ).toBe(false);
    expect(matchSubscription(event({ eventType: null }), sub({ eventTypes: ["*"] }))).toBe(true);
  });

  it("matches if ANY listed pattern matches (OR within the axis)", () => {
    const s = sub({ eventTypes: ["invoice.paid", "charge.*"] });
    expect(matchSubscription(event({ eventType: "charge.succeeded" }), s)).toBe(true);
    expect(matchSubscription(event({ eventType: "invoice.paid" }), s)).toBe(true);
    expect(matchSubscription(event({ eventType: "customer.created" }), s)).toBe(false);
  });

  it("an empty event_types list matches nothing (degenerate — the schema default is ['*'])", () => {
    expect(matchSubscription(event(), sub({ eventTypes: [] }))).toBe(false);
  });
});

describe("matchSubscription — require_verified axis", () => {
  it("require_verified gates on the event's verified flag", () => {
    expect(matchSubscription(event({ verified: true }), sub({ requireVerified: true }))).toBe(true);
    expect(matchSubscription(event({ verified: false }), sub({ requireVerified: true }))).toBe(
      false,
    );
    expect(matchSubscription(event({ verified: false }), sub({ requireVerified: false }))).toBe(
      true,
    );
  });
});

describe("matchSubscription — enabled + AND-combination", () => {
  it("a disabled subscription never matches", () => {
    expect(matchSubscription(event(), sub({ enabled: false }))).toBe(false);
  });

  it("ALL axes must hold — a single failing axis fails the whole match", () => {
    const strict = sub({
      provider: "stripe",
      eventTypes: ["charge.*"],
      requireVerified: true,
      enabled: true,
    });
    expect(
      matchSubscription(
        event({ provider: "stripe", eventType: "charge.x", verified: true }),
        strict,
      ),
    ).toBe(true);
    expect(
      matchSubscription(
        event({ provider: "github", eventType: "charge.x", verified: true }),
        strict,
      ),
    ).toBe(false); // provider
    expect(
      matchSubscription(
        event({ provider: "stripe", eventType: "invoice.x", verified: true }),
        strict,
      ),
    ).toBe(false); // type
    expect(
      matchSubscription(
        event({ provider: "stripe", eventType: "charge.x", verified: false }),
        strict,
      ),
    ).toBe(false); // verified
  });
});
