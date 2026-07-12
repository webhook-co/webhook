import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MARKETING_ROUTES, sitemapRoutes } from "./routes";

// The route manifest is the single source of truth that keeps four gates honest: the sitemap, the
// built-HTML SEO check, the export check, and the real-browser a11y scan all derive their page list
// from here (directly, or via the emitted sitemap.xml). So the invariants that make those gates
// trustworthy are asserted here, once.

describe("MARKETING_ROUTES", () => {
  it("has the home route, and it is the sitemap priority anchor", () => {
    const home = MARKETING_ROUTES.find((r) => r.path === "/");
    expect(home, "the home route must exist").toBeDefined();
    expect(home?.priority).toBe(1);
    expect(home?.sitemap).toBe(true);
    expect(home?.a11y).toBe(true);
  });

  it("still contains every route the site ships today (regression guard)", () => {
    const paths = MARKETING_ROUTES.map((r) => r.path);
    for (const shipped of [
      "/",
      "/pricing",
      "/terms",
      "/privacy",
      "/dpa",
      "/acceptable-use",
      "/sub-processors",
    ]) {
      expect(paths, `${shipped} must stay in the manifest`).toContain(shipped);
    }
  });

  it("has no duplicate paths", () => {
    const paths = MARKETING_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("every path is site-absolute and has no trailing slash (except root)", () => {
    for (const r of MARKETING_ROUTES) {
      expect(r.path.startsWith("/"), `${r.path} must start with /`).toBe(true);
      if (r.path !== "/") {
        expect(r.path.endsWith("/"), `${r.path} must not end with /`).toBe(false);
      }
    }
  });

  it("every priority is within the sitemap's 0..1 range", () => {
    for (const r of MARKETING_ROUTES) {
      expect(r.priority).toBeGreaterThanOrEqual(0);
      expect(r.priority).toBeLessThanOrEqual(1);
    }
  });

  it("exposes only the sitemap-listed routes via sitemapRoutes()", () => {
    const listed = sitemapRoutes();
    expect(listed.every((r) => r.sitemap)).toBe(true);
    expect(listed.length).toBe(MARKETING_ROUTES.filter((r) => r.sitemap).length);
  });
});

// Reconciliation: the manifest's "one row, gated everywhere" promise only holds if the manifest and
// the actual app/ routes agree. Derive the real route set from the filesystem (every app/**/page.tsx)
// and require it to EQUAL the manifest's path set. Without this, adding app/about/page.tsx without a
// manifest row would ship /about with zero SEO/canonical/a11y/export coverage and nothing would go
// red — the same un-gated-new-page failure this manifest exists to prevent, moved up one level.
describe("manifest ↔ filesystem reconciliation", () => {
  // vitest (turbo/pnpm --filter) runs with cwd = the apps/www package dir. Resolve src/app from
  // there — `import.meta.url` is not a reliable file:// URL under Vite's transform. If cwd is ever
  // wrong, the "finds page.tsx files" guard below fails loudly rather than passing vacuously.
  const appDir = resolve(process.cwd(), "src/app");

  /** Map an app/-relative page.tsx path to its route path. Strips Next route-group `(segments)`. */
  function routePathForPageFile(rel: string): string {
    const withoutFile = rel.replace(/\/?page\.tsx$/, "");
    const segments = withoutFile
      .split("/")
      .filter((s) => s.length > 0 && !(s.startsWith("(") && s.endsWith(")")));
    return segments.length === 0 ? "/" : `/${segments.join("/")}`;
  }

  const pageFiles = readdirSync(appDir, { recursive: true })
    .map(String)
    .filter((p) => p === "page.tsx" || p.endsWith("/page.tsx"));

  it("finds page.tsx files on disk (guard on the guard — a broken walk must not pass vacuously)", () => {
    expect(pageFiles.length).toBeGreaterThan(0);
  });

  it("has a manifest row for every page.tsx, and no manifest row without a page", () => {
    const fsRoutes = new Set(pageFiles.map(routePathForPageFile));
    const manifestRoutes = new Set(MARKETING_ROUTES.map((r) => r.path));

    const missingFromManifest = [...fsRoutes].filter((p) => !manifestRoutes.has(p));
    const missingFromFs = [...manifestRoutes].filter((p) => !fsRoutes.has(p));

    expect(
      missingFromManifest,
      `these routes exist as app/**/page.tsx but are NOT in MARKETING_ROUTES — add a manifest row ` +
        `so they're SEO/a11y/export-gated: ${missingFromManifest.join(", ")}`,
    ).toEqual([]);
    expect(
      missingFromFs,
      `these routes are in MARKETING_ROUTES but have no app/**/page.tsx — remove the stale row or ` +
        `add the page: ${missingFromFs.join(", ")}`,
    ).toEqual([]);
  });
});
