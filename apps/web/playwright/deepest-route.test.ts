import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  appRoutes,
  byDepthDesc,
  deepestAppRoute,
  isRouteTableReady,
  probeUrlFor,
  urlSegments,
} from "./deepest-route";

/** Build a throwaway app tree. `dir|file` puts a specific route file in that directory. */
function tree(spec: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "approutes-"));
  for (const entry of spec) {
    const [dir, file = "page.tsx"] = entry.split("|");
    const abs = join(root, dir!);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, file), "export default function P() { return null }\n");
  }
  return root;
}

describe("appRoutes", () => {
  it("finds every page, at every depth", () => {
    const root = tree(["(app)", "(app)/org/[slug]/events", "(app)/[...legacy]"]);
    const found = appRoutes(root)
      .map((r) => r.join("/"))
      .sort();
    expect(found).toEqual(["(app)", "(app)/[...legacy]", "(app)/org/[slug]/events"]);
  });

  // Route HANDLERS resolve from the same route table as pages, so the deepest one is the last thing the
  // scan reaches — and in this app it IS a route handler. Matching only `page.tsx` would silently exclude
  // the true worst case.
  it("counts route handlers and every page extension, not just page.tsx", () => {
    const root = tree(["a|route.ts", "b|page.jsx", "c|page.mdx", "d|layout.tsx"]);
    const found = appRoutes(root)
      .map((r) => r.join("/"))
      .sort();
    expect(found).toEqual(["a", "b", "c"]); // layout.tsx is not routable
  });
});

describe("urlSegments", () => {
  it("drops route groups — they contribute no URL segment", () => {
    expect(urlSegments(["(app)", "org", "[slug]", "events"])).toEqual(["org", "[slug]", "events"]);
  });

  it("drops parallel route slots and strips interception markers", () => {
    expect(urlSegments(["(app)", "@modal", "(.)photo", "[id]"])).toEqual(["photo", "[id]"]);
  });
});

describe("byDepthDesc", () => {
  // A DIRECT test of the comparator, against a deliberately reversed input — the previous version sorted a
  // fixture tree and passed on readdir order alone (sorted on APFS), so deleting the tie-break would not
  // have broken it. Sorting a pre-reversed array cannot pass without the tie-break.
  it("breaks equal depths by code-unit order, whatever order the input arrived in", () => {
    const routes = [
      ["(app)", "b", "[x]"],
      ["(app)", "a", "[x]"],
    ];
    expect([...routes].sort(byDepthDesc)[0]).toEqual(["(app)", "a", "[x]"]);
    expect([...routes].reverse().sort(byDepthDesc)[0]).toEqual(["(app)", "a", "[x]"]);
  });

  it("puts the deeper route first regardless of name", () => {
    const shallow = ["(app)", "z"];
    const deep = ["(app)", "a", "b", "c"];
    expect([shallow, deep].sort(byDepthDesc)[0]).toEqual(deep);
  });
});

describe("deepestAppRoute", () => {
  it("returns the route with the most URL segments", () => {
    const root = tree([
      "(app)/[...legacy]",
      "(app)/org/[slug]/events",
      "(app)/org/[slug]/endpoints/[id]/events/[eventId]",
    ]);
    expect(urlSegments(deepestAppRoute(root)).join("/")).toBe(
      "org/[slug]/endpoints/[id]/events/[eventId]",
    );
  });
});

describe("probeUrlFor", () => {
  it("substitutes a placeholder for every dynamic segment and drops groups", () => {
    expect(probeUrlFor(["(app)", "org", "[slug]", "endpoints", "[id]"])).toBe(
      "/org/00000000-0000-4000-8000-000000000000/endpoints/00000000-0000-4000-8000-000000000000",
    );
  });
});

// THE DRIFT GUARD. The probe is only meaningful if it asks about the route that actually goes missing last.
// If someone adds a route deeper than the one global-setup probes, the probe silently stops covering the
// worst case — the same "a gate whose input is scoped cannot fail" shape that let this bug ship. Assert
// against the REAL app tree, not a fixture.
describe("the real app tree", () => {
  it("has the event-payload handler as its deepest route — the one global-setup probes", () => {
    expect(urlSegments(deepestAppRoute()).join("/")).toBe(
      "org/[slug]/endpoints/[id]/events/[eventId]/payload",
    );
  });
});

// THE PREDICATE THE WHOLE FLAKE FIX RESTS ON. Weakening it to `status !== 404`, to "any 307", or to
// "ignore the Location" would silently restore the broken behaviour and leave every other test green — the
// same shape as the bug this harness change exists to prevent. Each case below is one of those weakenings.
describe("isRouteTableReady", () => {
  const AUTH = "http://127.0.0.1:3199";

  it("is ready ONLY for a 307 to the auth origin — the one response the real gated route emits", () => {
    expect(isRouteTableReady(307, `${AUTH}/login`, AUTH)).toBe(true);
  });

  it("is not ready on 404 — the catch-all answered, the route is not in the table yet", () => {
    expect(isRouteTableReady(404, null, AUTH)).toBe(false);
  });

  it("is not ready on 500 — a broken binding must never count as booted", () => {
    expect(isRouteTableReady(500, null, AUTH)).toBe(false);
  });

  it("is not ready on 200 — a route that renders without the gate is not the route we asked for", () => {
    expect(isRouteTableReady(200, null, AUTH)).toBe(false);
  });

  it("is not ready on a 307 somewhere ELSE — only the auth origin proves the gate ran", () => {
    expect(isRouteTableReady(307, "http://example.test/login", AUTH)).toBe(false);
    expect(isRouteTableReady(307, "/org/acme/suspended", AUTH)).toBe(false);
  });

  it("is not ready on a 307 with no Location at all", () => {
    expect(isRouteTableReady(307, null, AUTH)).toBe(false);
  });

  it("is not ready on other redirect codes", () => {
    expect(isRouteTableReady(308, `${AUTH}/login`, AUTH)).toBe(false);
    expect(isRouteTableReady(302, `${AUTH}/login`, AUTH)).toBe(false);
  });
});
