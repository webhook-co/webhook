import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appPageRoutes, deepestAppPageRoute, probeUrlFor, urlSegments } from "./deepest-route";

function tree(spec: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "approutes-"));
  for (const dir of spec) {
    const abs = join(root, dir);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, "page.tsx"), "export default function P() { return null }\n");
  }
  return root;
}

describe("appPageRoutes", () => {
  it("finds every page.tsx, at every depth", () => {
    const root = tree(["(app)", "(app)/org/[slug]/events", "(app)/[...legacy]"]);
    const found = appPageRoutes(root)
      .map((r) => r.join("/"))
      .sort();
    expect(found).toEqual(["(app)", "(app)/[...legacy]", "(app)/org/[slug]/events"]);
  });
});

describe("urlSegments", () => {
  it("drops route groups — they contribute no URL segment", () => {
    expect(urlSegments(["(app)", "org", "[slug]", "events"])).toEqual(["org", "[slug]", "events"]);
  });
});

describe("deepestAppPageRoute", () => {
  // The readiness probe exists because `next dev` begins serving at the end of its FIRST watchpack
  // aggregation, which can be a partially-scanned tree. The deepest route is the last one a recursive scan
  // reaches, so it is the one that goes missing — and while it is missing the catch-all claims its URLs.
  it("returns the route with the most URL segments", () => {
    const root = tree([
      "(app)/[...legacy]",
      "(app)/org/[slug]/events",
      "(app)/org/[slug]/endpoints/[id]/events/[eventId]",
    ]);
    expect(deepestAppPageRoute(root)).toEqual([
      "(app)",
      "org",
      "[slug]",
      "endpoints",
      "[id]",
      "events",
      "[eventId]",
    ]);
  });

  it("breaks ties deterministically rather than on readdir order", () => {
    const root = tree(["(app)/b/[x]", "(app)/a/[x]"]);
    expect(deepestAppPageRoute(root)).toEqual(["(app)", "a", "[x]"]);
  });
});

describe("probeUrlFor", () => {
  it("substitutes a placeholder for every dynamic segment and drops groups", () => {
    expect(probeUrlFor(["(app)", "org", "[slug]", "endpoints", "[id]"])).toBe(
      "/org/00000000-0000-4000-8000-000000000000/endpoints/00000000-0000-4000-8000-000000000000",
    );
  });
});

// THE DRIFT GUARD. The probe is only meaningful if it asks about the route that actually goes missing. If
// someone adds a route deeper than the one global-setup probes, the probe silently stops covering the worst
// case — the same "a gate whose input is scoped cannot fail" shape that let this bug ship in the first
// place. Assert against the REAL app tree, not a fixture.
describe("the real app tree", () => {
  it("has the event-detail route as its deepest page — the route global-setup probes", () => {
    expect(urlSegments(deepestAppPageRoute()).join("/")).toBe(
      "org/[slug]/endpoints/[id]/events/[eventId]",
    );
  });
});
