import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ORG_SLUG_RESERVED } from "@webhook-co/shared";
import { describe, expect, it } from "vitest";

import { buildLegacyTarget, isLegacyDashboardPath, MOVED_SEGMENTS } from "./legacy-redirect";

describe("isLegacyDashboardPath", () => {
  it("is true for a known moved top-level segment", () => {
    expect(isLegacyDashboardPath(["endpoints"])).toBe(true);
    expect(isLegacyDashboardPath(["billing"])).toBe(true);
    // Only the FIRST segment decides — a deep old link still keys on its root.
    expect(isLegacyDashboardPath(["endpoints", "abc", "events", "xyz"])).toBe(true);
  });

  it("is false for an unknown first segment, so genuine 404s stay 404s (not redirect-then-404)", () => {
    expect(isLegacyDashboardPath(["nope"])).toBe(false);
    // `events` USED to assert false here, with the note "never a top-level route (events are endpoint-scoped)".
    // That stopped being true when the consolidated org-wide browse landed at /org/{slug}/events — so the
    // assertion is inverted rather than deleted, and it now pins the new truth.
    expect(isLegacyDashboardPath(["events"])).toBe(true);
    expect(isLegacyDashboardPath(["org"])).toBe(false); // the new prefix is not itself a legacy path
  });

  it("is false for an empty or missing path", () => {
    expect(isLegacyDashboardPath([])).toBe(false);
    expect(isLegacyDashboardPath(undefined)).toBe(false);
  });
});

describe("buildLegacyTarget", () => {
  it("forwards a bare segment under the org", () => {
    expect(buildLegacyTarget("acme", ["endpoints"], {})).toBe("/org/acme/endpoints");
  });

  it("preserves the FULL deep sub-path", () => {
    expect(buildLegacyTarget("acme", ["endpoints", "ep_1", "events", "ev_2"], {})).toBe(
      "/org/acme/endpoints/ep_1/events/ev_2",
    );
  });

  it("preserves the query string", () => {
    expect(buildLegacyTarget("acme", ["deliveries"], { status: "failed", cursor: "c1" })).toBe(
      "/org/acme/deliveries?status=failed&cursor=c1",
    );
  });

  it("preserves repeated (array) query params", () => {
    expect(buildLegacyTarget("acme", ["events"], { tag: ["a", "b"] })).toBe(
      "/org/acme/events?tag=a&tag=b",
    );
  });

  it("drops undefined query values and encodes path segments", () => {
    expect(buildLegacyTarget("acme", ["endpoints", "a b"], { q: undefined })).toBe(
      "/org/acme/endpoints/a%20b",
    );
  });
});

describe("MOVED_SEGMENTS drift guard", () => {
  it("matches EXACTLY the top-level routes under /org/[slug] — add a new section, add its legacy redirect", () => {
    // A new dashboard section under /org/[slug]/ that isn't added here would have its old bookmark silently
    // 404 again — the very bug this fixes. This test forces the two to stay in lockstep.
    // Build the path with `join` (NOT `new URL`, which would percent-encode the `[slug]`/`(app)` brackets).
    const here = dirname(fileURLToPath(import.meta.url));
    const slugDir = join(here, "..", "app", "(app)", "org", "[slug]");
    const onDisk = readdirSync(slugDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect([...MOVED_SEGMENTS].sort()).toEqual(onDisk);
  });
});

// A legacy-redirect segment that a user can ALSO register as an org slug is a cross-org misdirect waiting to
// happen: `(app)/[...legacy]` claims any first segment in MOVED_SEGMENTS and 307s the reader to their DEFAULT
// org, and if the second segment is a registrable slug the target is a REAL org they never asked for. Every
// moved segment must therefore be reserved. `suspended` was the one that wasn't — it postdates migration 0069
// where the rest were reserved — and this guard is what caught it. (`ORG_SLUG_RESERVED` ⇔ the DB
// `org_slug_reserved()` function is guarded separately by org-slug-parity.test.ts, so a segment reserved here
// is reserved at the database too.)
describe("MOVED_SEGMENTS ⊆ ORG_SLUG_RESERVED", () => {
  it("reserves every legacy segment, so none can name a real org", () => {
    const registrable = [...MOVED_SEGMENTS].filter((s) => !ORG_SLUG_RESERVED.has(s));
    expect(registrable, "moved segments a user could still register as an org slug").toEqual([]);
  });
});
