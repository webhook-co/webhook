import { randomUUID } from "node:crypto";
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
 * Turn a route's segments into a concrete URL, substituting a FRESH uuid for each dynamic segment.
 *
 * A uuid deliberately: every id-shaped segment we route on is a uuid column, so this reaches the route's
 * own gate rather than being rejected by a shape check first.
 *
 * ── Why a fresh one per call, and not a constant ───────────────────────────────────────────────────────
 *
 * `next dev` resolves a URL to a route on its FIRST request and caches that binding per URL. A poll that
 * lands before the filesystem scan has registered the deep route is therefore claimed by the catch-all
 * `(app)/[...legacy]`, which compiles, calls `notFound()` — and then answers every LATER poll for that
 * same URL straight from the cached match. Re-asking one constant URL can never observe the route table
 * completing, because nothing re-resolves it.
 *
 * That is not hypothetical: it is exactly how CI went red on a commit whose `apps/web` tree was
 * byte-identical to the green one before it — a single `○ Compiling /[...legacy]`, then 542 identical
 * 404s served in ~2ms of Next time apiece, then the 180s boot timeout blaming `next dev` for never
 * answering while it was answering the whole time. The green run on the same tree got its 307 on the
 * first request and never compiled the catch-all at all. Which side of that race a run lands on is the
 * only difference between them.
 *
 * A new uuid makes every poll a URL `next dev` has never resolved before, so each one is matched against
 * the route table as it stands AT THAT MOMENT — which is the question the probe means to ask.
 *
 * Generating it in here rather than accepting it as a parameter is the point: a caller cannot hoist it
 * out of the poll loop and quietly restore the constant, so this cannot regress with every test green.
 */
export function probeUrlFor(route: readonly string[]): string {
  const path = urlSegments(route)
    .map((s) => (s.startsWith("[") ? randomUUID() : s))
    .join("/");
  return `/${path}`;
}

/**
 * Does this response prove the probed route is IN `next dev`'s route table?
 *
 * A POSITIVE marker, deliberately, rather than the absence of one bad status. Unauthenticated and
 * cookie-less, every gated route under `/org/{slug}` runs `requireOrgAccess` → `verifySession` →
 * `redirect(LOGIN_URL)`, a 307 to the auth origin the harness itself chose. `(app)/[...legacy]` cannot
 * produce that: it rejects a first segment of `org` and calls `notFound()` before it reads any session.
 *
 * `status !== 404` was the first cut and was too weak in both directions. A 500 — a broken binding, a throw
 * in the gate — would have counted as ready, the very thing the `/dev-session` probe refuses. And it hung
 * entirely on the catch-all continuing to answer 404: the day it redirects instead, the check would pass on
 * the first poll forever and the fix would evaporate with every test still green.
 *
 * Pure and exported so that weakening IS a test failure — the whole flake fix rests on this one predicate.
 */
export function isRouteTableReady(
  status: number,
  location: string | null,
  authOrigin: string,
): boolean {
  return status === 307 && (location ?? "").startsWith(authOrigin);
}

// ── Waiting for the SCAN, not for a request ──────────────────────────────────────────────────────────
//
// The HTTP probe above answers "is the deep route serving?", which is the right final question. What it
// cannot do is distinguish "not registered YET" from "never will be" — so on a loaded CI runner it can
// spend its entire budget asking before `next dev` has finished scanning src/app, and report a timeout
// against a server that was healthy throughout.
//
// `next dev` writes the COMPLETE route table to a types file as soon as that scan finishes — before, and
// independently of, compiling anything. So the file appearing WITH the deepest route in it is a
// scan-completion signal that races with nothing.
//
// ⚠️ This is undocumented and version-dependent: `typedRoutes` defaults to FALSE and apps/web does not
// enable it, yet Next 16.2 emits this file in dev anyway. So it is used as an OPTIMISATION, never as a
// precondition — if the file never appears, the caller falls through to the HTTP probe and behaves exactly
// as it did before. Worst case is today's behaviour; best case the probe never starts too early.

/** Where `next dev` writes the scanned route table, relative to the app root. */
export const ROUTE_TYPES_FILE = ".next/dev/types/routes.d.ts";

/** Every route literal in the generated types file, across all of its union types. */
export function routeTypesListRoutes(text: string): readonly string[] {
  return [...text.matchAll(/"(\/[^"]*)"/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));
}

/**
 * Does the generated route table already list `route`?
 *
 * Compares the full URL path, so a PREFIX of the route (its parent, which the scan reaches first) does not
 * count as a match — that is precisely the state we are waiting to leave.
 */
export function routeTypesInclude(text: string, route: readonly string[]): boolean {
  const want = `/${urlSegments(route).join("/")}`;
  return routeTypesListRoutes(text).includes(want);
}
