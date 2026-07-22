import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Which app route is the LAST one `next dev` learns about — and therefore the one a readiness probe has to
// ask about. See `global-setup.ts` (`assertRouteTableComplete`) for why that matters.

// Resolved from the package root rather than `import.meta.url`: both consumers (vitest and the Playwright
// global setup) run with apps/web as the working directory, and the URL form resolves to the wrong place
// under vitest's module graph.
const APP_DIR = resolve(process.cwd(), "src/app");

/** A route-group segment — `(app)` — is organisational; it contributes no URL segment. */
const isGroup = (segment: string): boolean => segment.startsWith("(") && segment.endsWith(")");

/** Every `page.tsx` under `src/app`, as a list of directory segments relative to it. */
export function appPageRoutes(dir: string = APP_DIR): readonly (readonly string[])[] {
  const walk = (abs: string, segments: readonly string[]): (readonly string[])[] => {
    const entries = readdirSync(abs, { withFileTypes: true });
    const here = entries.some((e) => e.isFile() && e.name === "page.tsx") ? [segments] : [];
    const below = entries
      .filter((e) => e.isDirectory())
      .flatMap((e) => walk(join(abs, e.name), [...segments, e.name]));
    return [...here, ...below];
  };
  return walk(dir, []);
}

/** The URL segments a route contributes — route groups dropped. */
export const urlSegments = (route: readonly string[]): readonly string[] =>
  route.filter((s) => !isGroup(s));

/**
 * The DEEPEST app page route, by URL-segment count. Ties break on the joined path so the answer is stable
 * across filesystems (readdir order is not).
 */
export function deepestAppPageRoute(dir?: string): readonly string[] {
  const byDepth = [...appPageRoutes(dir)].sort((a, b) => {
    const d = urlSegments(b).length - urlSegments(a).length;
    return d !== 0 ? d : urlSegments(a).join("/").localeCompare(urlSegments(b).join("/"));
  });
  const deepest = byDepth[0];
  if (!deepest) throw new Error("no app page routes found");
  return deepest;
}

/** A placeholder that satisfies every id-shaped segment we route on (uuid columns, org slugs). */
const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

/** Turn a route's segments into a concrete URL, substituting a placeholder for each dynamic segment. */
export function probeUrlFor(route: readonly string[]): string {
  const path = urlSegments(route)
    .map((s) => (s.startsWith("[") ? PLACEHOLDER : s))
    .join("/");
  return `/${path}`;
}
