import { describe, expect, test } from "vitest";

import { spanSafeAttributes } from "./telemetry-safety.js";

describe("spanSafeAttributes", () => {
  test("drops url.path / url.full / url.query — they can carry the ingest bearer token", () => {
    // The wbhk.my ingest token IS the first path segment, so url.path is a live credential.
    const out = spanSafeAttributes({
      "url.path": "/whk_live_tokenmaterial",
      "url.full": "https://wbhk.my/whk_live_tokenmaterial?x=1",
      "url.query": "x=1",
      "http.request.method": "POST",
    });

    expect(out["url.path"]).toBeUndefined();
    expect(out["url.full"]).toBeUndefined();
    expect(out["url.query"]).toBeUndefined();
    // an allowlisted key survives, so the boundary isn't just dropping everything
    expect(out["http.request.method"]).toBe("POST");
  });

  test("drops keys that are on no allowlist (allowlist, not denylist)", () => {
    const out = spanSafeAttributes({ "some.unknown.attr": "x", "wbhk.outcome": "captured" });
    expect(out["some.unknown.attr"]).toBeUndefined();
    expect(out["wbhk.outcome"]).toBe("captured");
  });

  test("identifiers drop by default (export-safe) and survive only with allowIdentifiers (in-CF sinks)", () => {
    const attrs = {
      "wbhk.org_id": "org_123",
      "wbhk.event_id": "evt_9",
      "wbhk.outcome": "captured",
    };

    const exported = spanSafeAttributes(attrs);
    expect(exported["wbhk.org_id"]).toBeUndefined();
    expect(exported["wbhk.event_id"]).toBeUndefined();
    expect(exported["wbhk.outcome"]).toBe("captured");

    const inCf = spanSafeAttributes(attrs, { allowIdentifiers: true });
    expect(inCf["wbhk.org_id"]).toBe("org_123");
    expect(inCf["wbhk.event_id"]).toBe("evt_9");
    expect(inCf["wbhk.outcome"]).toBe("captured");
  });

  test("redacts a known-secret-shaped VALUE even on an allowlisted key (defense in depth)", () => {
    // a credential should never reach a safe key, but if it does it must not survive verbatim
    expect(spanSafeAttributes({ "wbhk.outcome": "whk_live_supersecret" })["wbhk.outcome"]).toBe(
      "whk_****",
    );
    expect(spanSafeAttributes({ "wbhk.outcome": "whsec_abcdef012345" })["wbhk.outcome"]).toBe(
      "whse****",
    );
    // an ordinary enum value is untouched
    expect(spanSafeAttributes({ "wbhk.outcome": "captured" })["wbhk.outcome"]).toBe("captured");
  });

  test("header attributes drop by default (export-safe) and pass — allowlisted only — for in-CF sinks", () => {
    // The loggable header allowlist was built for in-CF logging and contains per-event identifiers
    // (webhook-id, x-github-delivery), so header attributes are an in-CF concern: none reach an
    // exported span, and even in-CF, auth/signature headers stay redacted-away.
    const attrs = {
      "http.request.header.content-type": "application/json",
      "http.request.header.authorization": "Bearer sk_live_x",
      "http.request.header.webhook-id": "msg_2abcDEF", // a per-event id that IS on the loggable allowlist
    };

    const exported = spanSafeAttributes(attrs);
    expect(exported["http.request.header.content-type"]).toBeUndefined();
    expect(exported["http.request.header.webhook-id"]).toBeUndefined();

    const inCf = spanSafeAttributes(attrs, { allowIdentifiers: true });
    expect(inCf["http.request.header.content-type"]).toBe("application/json");
    expect(inCf["http.request.header.authorization"]).toBeUndefined();
    expect(inCf["http.request.header.webhook-id"]).toBe("msg_2abcDEF");
  });

  test("redacts a credential embedded after a delimiter (e.g. a full ingest URL) on a string key", () => {
    // defense in depth: even if a full URL carrying the token lands on an allowlisted key, mask it
    expect(
      spanSafeAttributes({ "wbhk.outcome": "https://wbhk.my/whk_live_secret" })["wbhk.outcome"],
    ).toBe("http****");
  });
});
