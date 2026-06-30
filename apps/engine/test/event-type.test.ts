import { describe, expect, it } from "vitest";

import { extractEventType } from "../src/dedup";

// Per-provider event_type derivation (S3 Slice 3 PR2c): normalize the provider's event-type signal from
// headers (GitHub `x-github-event`, Shopify `x-shopify-topic`) or the body (Stripe `.type`). An unextracted
// type → null, which the subscription matcher routes via `*` only (never a hard failure). Pure.

const enc = (s: string) => new TextEncoder().encode(s);
type H = ReadonlyArray<readonly [string, string]>;
const NO_HEADERS: H = [];

describe("extractEventType", () => {
  it("stripe: reads the body `.type` (e.g. charge.succeeded)", () => {
    expect(
      extractEventType("stripe", enc('{"type":"charge.succeeded","id":"evt_1"}'), NO_HEADERS),
    ).toBe("charge.succeeded");
  });

  it("github: reads the x-github-event header (case-insensitive)", () => {
    expect(extractEventType("github", enc("{}"), [["X-GitHub-Event", "pull_request"]])).toBe(
      "pull_request",
    );
  });

  it("shopify: reads the x-shopify-topic header", () => {
    expect(extractEventType("shopify", enc("{}"), [["x-shopify-topic", "orders/create"]])).toBe(
      "orders/create",
    );
  });

  it("returns null for an unknown/unsupported provider (→ routes via `*`)", () => {
    expect(extractEventType("twilio", enc('{"type":"x"}'), NO_HEADERS)).toBeNull();
    expect(extractEventType(null, enc('{"type":"x"}'), NO_HEADERS)).toBeNull();
  });

  it("returns null when the signal is absent or the body is malformed (graceful)", () => {
    expect(extractEventType("stripe", enc('{"id":"evt_1"}'), NO_HEADERS)).toBeNull(); // no .type
    expect(extractEventType("stripe", enc("not json"), NO_HEADERS)).toBeNull(); // malformed
    expect(extractEventType("github", enc("{}"), NO_HEADERS)).toBeNull(); // header missing
    expect(extractEventType("stripe", enc('{"type":""}'), NO_HEADERS)).toBeNull(); // empty string
  });
});
