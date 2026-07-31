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
  return status === 307 && locationHasOrigin(location, authOrigin) === true;
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

/**
 * The auth origin the app will ACTUALLY redirect to, given the `.dev.vars` this machine has.
 *
 * The probe's whole discriminator is "a 307 to the auth origin, which the catch-all cannot produce". That
 * only works if the harness expects the origin the app really uses — and the harness does not get to
 * choose. `getAuthBaseUrl()` resolves BINDING-FIRST (`workerEnv() ?? process.env`), and under `next dev`
 * the binding comes from `getPlatformProxy`, which reads `apps/web/.dev.vars`. So a machine that has run
 * `pnpm dev:secrets` redirects to http://localhost:3001 no matter what the harness puts in process.env.
 *
 * The symptom was maximally misleading: a route serving correctly within a second, reported after 180
 * seconds as "never entered its route table". Green on CI, where there is no `.dev.vars` at all, and dead
 * on every developer machine.
 *
 * Falling back to the harness's own origin keeps CI isolated exactly as before — an origin nothing else in
 * the app points at — so this widens nothing where the old assumption already held.
 */
export function effectiveAuthOrigin(devVars: string | null, fallback: string): string {
  // Parsed the way `scripts/dev-preflight.mjs` parses the same file, because anything this mishandles
  // silently reinstates the 180-second misdiagnosis above. In particular a QUOTED value — which that
  // parser strips and a naive one does not — would be read with its quotes and never match the redirect.
  let value = "";
  for (const raw of (devVars ?? "").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue; // a commented key is not configuration
    const at = line.indexOf("=");
    if (at < 0 || line.slice(0, at).trim() !== "AUTH_BASE_URL") continue; // exact key, not a suffix match
    value = line.slice(at + 1).trim();
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    break;
  }
  // A blank is UNSET — `pnpm dev:secrets` writes an unconfigured key as `NAME=`, and demanding a redirect
  // to the empty string would never match.
  return stripTrailingSlash(value === "" ? fallback : value);
}

const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, "");

/**
 * Does `location` point at `origin`? Compared as ORIGINS, never as a string prefix.
 *
 * `startsWith` cannot tell http://localhost:3001 from http://localhost:30010, so a genuinely mismatched
 * origin that happens to share a prefix would read as correct — the readiness predicate would accept the
 * wrong server, and the fast-fail would miss the case it exists for.
 *
 * A relative or unparseable Location is NOT a match and NOT a mismatch: it means "keep polling". A false
 * fast-fail would trade a slow correct answer for a quick wrong one, which is the worse bargain.
 */
export function locationHasOrigin(location: string | null, origin: string): boolean | null {
  if (location === null) return null;
  try {
    return new URL(location).origin === new URL(origin).origin;
  } catch {
    return null; // relative or malformed — undecidable, so decide nothing
  }
}

/**
 * Is this response a CONFIGURATION mismatch rather than a route table still filling in?
 *
 * The catch-all `(app)/[...legacy]` rejects a first segment of `org` and calls `notFound()`, so a partial
 * table yields 404 — never a redirect. A 307 therefore proves the real route is serving; if its Location
 * points somewhere other than the origin the harness expects, the route is fine and the EXPECTATION is
 * wrong. Continuing to poll that for the full boot budget and then reporting "never entered its route
 * table" sends the reader through the wrong subsystem entirely, which is precisely what happened.
 */
export function authOriginMismatch(
  status: number,
  location: string | null,
  authOrigin: string,
): boolean {
  return status === 307 && locationHasOrigin(location, authOrigin) === false;
}
