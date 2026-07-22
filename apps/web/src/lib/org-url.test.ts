import { describe, expect, it } from "vitest";

import { MOVED_SEGMENTS } from "@/server/legacy-redirect";

import { orgHref, queryString } from "./org-url";

describe("orgHref", () => {
  it("prefixes the org", () => {
    expect(orgHref("acme", "/endpoints/123")).toBe("/org/acme/endpoints/123");
  });

  // THE CLAIM THIS PINS. orgHref's contract for a missing slug is "a broken link beats a wrong one" — it
  // must never link into a DIFFERENT org. A bare `/endpoints/123/events/456` does not honour that: its first
  // segment is in MOVED_SEGMENTS, so `(app)/[...legacy]` claims it and 307s the reader to their DEFAULT
  // org — silently, and to an org they did not ask for. Whatever a slug-less orgHref returns, the legacy
  // catch-all must not be able to capture it.
  it("never emits a path the legacy catch-all can redirect into another org", () => {
    for (const segment of MOVED_SEGMENTS) {
      const href = orgHref("", `/${segment}/123/events/456`);
      const first = href.split("/").filter(Boolean)[0];
      expect(MOVED_SEGMENTS.has(first ?? "")).toBe(false);
    }
  });

  it("still resolves a slug-less link to a 404-able path, not a silent no-op", () => {
    expect(orgHref("", "/endpoints/123")).toBe("/org/endpoints/123");
  });
});

describe("queryString", () => {
  it("serialises params, including repeated ones", () => {
    expect(queryString({ a: "b", c: ["d", "e"], f: undefined })).toBe("?a=b&c=d&c=e");
  });

  it("is empty when there are none", () => {
    expect(queryString({})).toBe("");
  });
});
