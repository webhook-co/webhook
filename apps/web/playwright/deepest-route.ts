import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Which app route is the LAST one `next dev` learns about — and therefore the one a readiness probe has to
// ask about. See `routeTableIsComplete` in `global-setup.ts` for why that matters.

// Resolved from the package root: both consumers (vitest and the Playwright global setup) run with apps/web
// as their working directory.
const APP_DIR = resolve(process.cwd(), "src/app");

/**
 * Every filename Next treats as a routable entry — pages AND route handlers, in any of its extensions.
 *
 * Route HANDLERS count: `next dev` resolves them from the same route table as pages, so the deepest one is
 * the last thing the scan reaches whether or not it renders UI. Matching only `page.tsx` would have made
 * this file's central claim false — the deepest route in this app is `…/[eventId]/payload/route.ts`.
 */
const ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js|mdx)$/;

/**
 * Three kinds of Next segment are organisational and contribute NO URL segment: a route GROUP `(app)`, a
 * parallel route SLOT `@modal`, and the marker on an INTERCEPTING route (`(.)photo` routes as `photo`).
 * Treating any of them as a literal segment would build a probe URL that resolves to nothing, and the
 * readiness poll would then never succeed — a three-minute boot timeout blaming the wrong subsystem.
 */
const isGroup = (s: string): boolean => s.startsWith("(") && s.endsWith(")");
const isSlot = (s: string): boolean => s.startsWith("@");
const INTERCEPT = /^\(\.{1,3}\)/;

/** Every routable file under `src/app`, as a list of directory segments relative to it. */
export function appRoutes(dir: string = APP_DIR): readonly (readonly string[])[] {
  const walk = (abs: string, segments: readonly string[]): (readonly string[])[] => {
    const entries = readdirSync(abs, { withFileTypes: true });
    const here = entries.some((e) => e.isFile() && ROUTE_FILE.test(e.name)) ? [segments] : [];
    const below = entries
      .filter((e) => e.isDirectory())
      .flatMap((e) => walk(join(abs, e.name), [...segments, e.name]));
    return [...here, ...below];
  };
  return walk(dir, []);
}

/** The URL segments a route contributes — groups and slots dropped, interception markers stripped. */
export const urlSegments = (route: readonly string[]): readonly string[] =>
  route.filter((s) => !isGroup(s) && !isSlot(s)).map((s) => s.replace(INTERCEPT, ""));

/**
 * Order routes deepest-first.
 *
 * The tie-break is a CODE-UNIT compare, not `localeCompare`: localeCompare is ICU- and locale-dependent, so
 * it cannot deliver the "same answer on every machine" property this needs. readdir order is not stable
 * either (sorted on APFS, hash-ordered on ext4), so without a total order here the probe could target a
 * different route on a developer's machine than in CI.
 */
export function byDepthDesc(a: readonly string[], b: readonly string[]): number {
  const depth = urlSegments(b).length - urlSegments(a).length;
  if (depth !== 0) return depth;
  const x = urlSegments(a).join("/");
  const y = urlSegments(b).join("/");
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The DEEPEST app route, by URL-segment count — the last one a recursive filesystem scan reaches. */
export function deepestAppRoute(dir?: string): readonly string[] {
  const deepest = [...appRoutes(dir)].sort(byDepthDesc)[0];
  if (!deepest) throw new Error("no app routes found");
  return deepest;
}

/**
 * A placeholder for a dynamic segment. Deliberately a uuid: every id-shaped segment we route on is a uuid
 * column, so this reaches the route's own gate rather than being rejected by a shape check first.
 */
const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

/** Turn a route's segments into a concrete URL, substituting a placeholder for each dynamic segment. */
export function probeUrlFor(route: readonly string[]): string {
  const path = urlSegments(route)
    .map((s) => (s.startsWith("[") ? PLACEHOLDER : s))
    .join("/");
  return `/${path}`;
}
