import { describe, expect, it } from "vitest";

import {
  ADVISORY_HEADER,
  CLIENT_LATEST,
  CLIENT_MIN_SUPPORTED,
  buildAdvisory,
  compareSemver,
  parseClientUserAgent,
} from "./client-advisory.js";

describe("parseClientUserAgent", () => {
  it("parses the id and version out of our own clients' user-agents", () => {
    expect(parseClientUserAgent("webhook-co-js/0.2.1 (node/24.1.0; darwin/arm64)")).toEqual({
      id: "webhook-co-js",
      version: "0.2.1",
    });
    expect(parseClientUserAgent("webhook-co-python/0.2.1 (python/3.12.3; linux)")).toEqual({
      id: "webhook-co-python",
      version: "0.2.1",
    });
    expect(parseClientUserAgent("webhook-co-go/0.3.0 (go1.22; linux/amd64)")).toEqual({
      id: "webhook-co-go",
      version: "0.3.0",
    });
    expect(parseClientUserAgent("wbhk-cli/0.2.0 (node/24.1.0; darwin/arm64)")).toEqual({
      id: "wbhk-cli",
      version: "0.2.0",
    });
  });

  // A browser, curl, or somebody's homegrown client is NOT ours — never advise it, never guess. Returning
  // null here is what keeps the advisory header off every third-party request.
  it("returns null for a user-agent that is not one of ours", () => {
    expect(parseClientUserAgent("curl/8.4.0")).toBeNull();
    expect(parseClientUserAgent("Mozilla/5.0 (Macintosh)")).toBeNull();
    expect(parseClientUserAgent("")).toBeNull();
    expect(parseClientUserAgent(null)).toBeNull();
    expect(parseClientUserAgent("webhook-co-evil/1.0")).toBeNull(); // an id we don't know
  });

  it("tolerates a missing suffix and stray whitespace", () => {
    expect(parseClientUserAgent("  webhook-co-js/1.2.3  ")).toEqual({
      id: "webhook-co-js",
      version: "1.2.3",
    });
  });

  it("rejects a malformed version rather than half-parsing it", () => {
    expect(parseClientUserAgent("webhook-co-js/not-a-version")).toBeNull();
    expect(parseClientUserAgent("webhook-co-js/")).toBeNull();
    expect(parseClientUserAgent("webhook-co-js")).toBeNull();
  });
});

describe("compareSemver", () => {
  it("orders by major, then minor, then patch — NUMERICALLY, not as strings", () => {
    expect(compareSemver("0.2.0", "0.3.0")).toBe(-1);
    expect(compareSemver("0.3.0", "0.2.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    // The string trap: "0.10.0" < "0.9.0" lexicographically, but 10 > 9.
    expect(compareSemver("0.9.0", "0.10.0")).toBe(-1);
    expect(compareSemver("0.2.10", "0.2.9")).toBe(1);
  });

  it("treats a prerelease as older than its release (0.3.0-rc.1 < 0.3.0)", () => {
    expect(compareSemver("0.3.0-rc.1", "0.3.0")).toBe(-1);
    expect(compareSemver("0.3.0", "0.3.0-rc.1")).toBe(1);
  });
});

describe("buildAdvisory", () => {
  it("says nothing when the client is on the latest version (the common case must be SILENT)", () => {
    const latest = CLIENT_LATEST["webhook-co-js"];
    expect(buildAdvisory({ id: "webhook-co-js", version: latest })).toBeNull();
  });

  it("says nothing when the client is AHEAD of what we know (a prerelease, or we forgot to bump)", () => {
    expect(buildAdvisory({ id: "webhook-co-js", version: "99.0.0" })).toBeNull();
  });

  it("advises an update — WITHOUT deprecating — for a version that is stale but still supported", () => {
    // Must be >= the supported floor and < latest. Deprecating a version that still works fine trains
    // people to ignore the header, so this distinction is the whole point.
    const floor = CLIENT_MIN_SUPPORTED["webhook-co-js"];
    const latest = CLIENT_LATEST["webhook-co-js"];
    expect(compareSemver(floor, latest)).toBe(-1); // guard: the fixture is genuinely between the two
    const advisory = buildAdvisory({ id: "webhook-co-js", version: floor });
    expect(advisory).not.toBeNull();
    expect(advisory!.deprecated).toBe(false);
    expect(advisory!.headerValue).toContain("update-available");
    expect(advisory!.headerValue).toContain(`current=${floor}`);
    expect(advisory!.headerValue).toContain(`latest=${latest}`);
  });

  it("marks a version below the minimum SUPPORTED as deprecated (not merely stale)", () => {
    // Pin a known-unsupported version: anything below the declared floor.
    const floor = CLIENT_MIN_SUPPORTED["webhook-co-js"];
    expect(compareSemver("0.0.1", floor)).toBe(-1); // guard: the fixture really is below the floor
    const advisory = buildAdvisory({ id: "webhook-co-js", version: "0.0.1" });
    expect(advisory!.deprecated).toBe(true);
    expect(advisory!.headerValue).toContain("deprecated");
  });

  it("never advises a client we don't recognise", () => {
    expect(buildAdvisory(null)).toBeNull();
  });

  // The header rides on responses the caller already asked for. It must never carry anything but version
  // facts — no ids, no keys, nothing about the caller.
  it("emits ONLY version facts in the header value", () => {
    const advisory = buildAdvisory({ id: "webhook-co-js", version: "0.0.1" });
    expect(advisory!.headerValue).toMatch(/^[a-z-]+; current=[\w.+-]+; latest=[\w.+-]+$/);
  });
});

describe("the version registry", () => {
  it("declares a latest AND a minimum-supported for every client", () => {
    for (const id of Object.keys(CLIENT_LATEST)) {
      expect(CLIENT_MIN_SUPPORTED[id], `no minimum declared for ${id}`).toBeDefined();
    }
    for (const id of Object.keys(CLIENT_MIN_SUPPORTED)) {
      expect(CLIENT_LATEST[id], `no latest declared for ${id}`).toBeDefined();
    }
  });

  it("never declares a minimum ABOVE the latest (that would deprecate everyone, including the newest)", () => {
    for (const [id, latest] of Object.entries(CLIENT_LATEST)) {
      expect(
        compareSemver(CLIENT_MIN_SUPPORTED[id]!, latest),
        `${id}: minimum ${CLIENT_MIN_SUPPORTED[id]} is above latest ${latest}`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it("uses a lowercase header name (Workers normalises, but our tests should not depend on that)", () => {
    expect(ADVISORY_HEADER).toBe(ADVISORY_HEADER.toLowerCase());
  });
});
