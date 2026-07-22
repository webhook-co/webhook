import { describe, expect, it } from "vitest";

import { validateOrgSlug } from "@webhook-co/shared";

import { MOVED_SEGMENTS } from "@/server/legacy-redirect";

import { orgHref, queryString } from "./org-url";

describe("orgHref", () => {
  it("prefixes the org", () => {
    expect(orgHref("acme", "/endpoints/123")).toBe("/org/acme/endpoints/123");
  });

  // THE CLAIM THIS PINS. orgHref's contract for a missing slug is "a broken link beats a wrong one" — it
  // must never link into a DIFFERENT org. Two ways that can break, and both are asserted against the REAL
  // sets rather than a copy: the legacy catch-all must not be able to claim the path (first segment in
  // MOVED_SEGMENTS), and the slug the path then resolves to must be one no org can ever hold. The second is
  // the one that bites: MOVED_SEGMENTS contains `suspended`, which is NOT reserved, so a fallback that
  // merely avoided the catch-all would still land in a real org for anyone who registered that slug.
  it("never emits a path the legacy catch-all can redirect into another org", () => {
    for (const segment of MOVED_SEGMENTS) {
      const [first] = orgHref("", `/${segment}/123/events/456`).split("/").filter(Boolean);
      expect(MOVED_SEGMENTS.has(first ?? "")).toBe(false);
    }
  });

  it("routes through a slug no org can ever hold, for every moved segment", () => {
    for (const segment of MOVED_SEGMENTS) {
      const [, slug] = orgHref("", `/${segment}/123`).split("/").filter(Boolean);
      expect(validateOrgSlug(slug ?? "").ok).toBe(false);
    }
  });

  it("still resolves a slug-less link to a 404-able path, not a silent no-op", () => {
    expect(orgHref("", "/endpoints/123")).toBe("/org/-/endpoints/123");
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
