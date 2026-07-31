import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ROUTE_TYPES_FILE,
  appRoutes,
  authOriginMismatch,
  awaitRouteScan,
  byDepthDesc,
  deepestAppRoute,
  effectiveAuthOrigin,
  isRouteTableReady,
  probeUrlFor,
  routeTypesInclude,
  routeTypesListRoutes,
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

// ── The scan-completion gate ──────────────────────────────────────────────────────────────────────────
// The HTTP probe cannot distinguish "the deep route is not registered YET" from "it never will be", so on
// a loaded CI runner it can burn its whole budget asking a question the server is not ready to answer.
// `next dev` writes the COMPLETE route table to a types file as soon as it has scanned src/app — before,
// and independently of, compiling anything. Reading that file is therefore a scan-completion signal that
// does not race with matching or compilation.
describe("routeTypesInclude", () => {
  // A trimmed copy of what `next dev` actually emits (Next 16.2).
  const REAL = [
    'type AppRoutes = "/" | "/[...legacy]" | "/org/[slug]/dashboard"',
    'type AppRouteHandlerRoutes = "/dev-session" | "/org/[slug]/endpoints/[id]/events/[eventId]/payload" | "/readyz"',
    "type PageRoutes = never",
  ].join("\n");

  const PAYLOAD = ["(app)", "org", "[slug]", "endpoints", "[id]", "events", "[eventId]", "payload"];

  it("finds a route handler listed in AppRouteHandlerRoutes", () => {
    expect(routeTypesInclude(REAL, PAYLOAD)).toBe(true);
  });

  it("finds a page listed in AppRoutes", () => {
    expect(routeTypesInclude(REAL, ["(app)", "org", "[slug]", "dashboard"])).toBe(true);
  });

  // The whole point: BEFORE the scan reaches it, the deep route is absent and we must keep waiting.
  it("returns false while the deepest route is still absent", () => {
    const partial =
      'type AppRoutes = "/" | "/[...legacy]"\ntype AppRouteHandlerRoutes = "/dev-session"';
    expect(routeTypesInclude(partial, PAYLOAD)).toBe(false);
  });

  it("is not fooled by a PREFIX of the route", () => {
    const prefix = 'type AppRouteHandlerRoutes = "/org/[slug]/endpoints/[id]/events/[eventId]"';
    expect(routeTypesInclude(prefix, PAYLOAD)).toBe(false);
  });

  it("drops route groups, so (app) never appears in the compared path", () => {
    expect(routeTypesListRoutes(REAL)).not.toContain("/(app)/org/[slug]/dashboard");
  });

  it("returns false on an empty or garbage file rather than throwing", () => {
    expect(routeTypesInclude("", PAYLOAD)).toBe(false);
    expect(routeTypesInclude("nothing to see here", PAYLOAD)).toBe(false);
  });

  it("points at the dev types file next writes", () => {
    expect(ROUTE_TYPES_FILE).toMatch(/routes\.d\.ts$/);
  });
});

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
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

  it("substitutes a uuid for every dynamic segment, keeps statics and drops groups", () => {
    expect(probeUrlFor(["(app)", "org", "[slug]", "endpoints", "[id]"])).toMatch(
      new RegExp(`^/org/${UUID}/endpoints/${UUID}$`),
    );
  });

  // THE FIX. `next dev` resolves a URL to a route on the FIRST request and caches that binding per URL:
  // a poll that lands before the scan has registered the deep route is claimed by `(app)/[...legacy]`,
  // which compiles, 404s, and then answers every later poll for that same URL from the cached match
  // (`next.js: 2ms`, and no second "Compiling" line) — so re-asking a CONSTANT url can never observe the
  // route table completing. That is the whole failure: one `Compiling /[...legacy]`, 542 identical 404s,
  // then the 180s boot timeout, on a commit whose apps/web tree was byte-identical to a green one.
  //
  // Generating the uuid HERE rather than taking it as a parameter is deliberate: a caller cannot hoist it
  // out of the poll loop and silently restore the constant, so the fix cannot evaporate with tests green.
  it("returns a DIFFERENT url each call, so no poll reuses a poisoned route binding", () => {
    const route = ["(app)", "org", "[slug]", "endpoints", "[id]"];
    const urls = new Set(Array.from({ length: 20 }, () => probeUrlFor(route)));
    expect(urls.size).toBe(20);
  });

  it("is stable for a route with no dynamic segments — there is nothing to vary", () => {
    expect(probeUrlFor(["(app)", "org", "settings"])).toBe("/org/settings");
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

// ── The auth origin the probe must expect ────────────────────────────────────────────────────────────
// The harness passed AUTH_BASE_URL to `next dev` via process.env and then demanded a 307 to that origin.
// But apps/web resolves it BINDING-FIRST (`getAuthBaseUrl`: workerEnv() ?? process.env), and under
// `next dev` the binding comes from getPlatformProxy — which reads `.dev.vars`. So on any machine that has
// run `pnpm dev:secrets`, the app redirected to http://localhost:3001 while the probe waited for
// http://127.0.0.1:3199, and the suite burned its whole 180s budget on a route that was serving correctly
// within a second. Green on CI (no `.dev.vars` there), dead on every developer machine — the inverse of
// the usual failure, and exactly the class this repo's local-parity work exists to remove.
describe("effectiveAuthOrigin", () => {
  it("uses the origin the app will ACTUALLY resolve when .dev.vars sets one", () => {
    expect(
      effectiveAuthOrigin("AUTH_BASE_URL=http://localhost:3001\n", "http://127.0.0.1:3199"),
    ).toBe("http://localhost:3001");
  });

  it("falls back to the harness's isolated origin when there is no .dev.vars", () => {
    // CI's case. Keeping the synthetic origin there preserves the property the comment relies on: an
    // origin nothing else in the app points at, so nothing can wander off to a real auth server.
    expect(effectiveAuthOrigin(null, "http://127.0.0.1:3199")).toBe("http://127.0.0.1:3199");
  });

  it("ignores a blank or absent binding rather than expecting an empty origin", () => {
    // `pnpm dev:secrets` writes an unconfigured key as `NAME=`; treating "" as configured would make the
    // probe demand a redirect to the empty string and never match.
    expect(effectiveAuthOrigin("AUTH_BASE_URL=\n", "http://127.0.0.1:3199")).toBe(
      "http://127.0.0.1:3199",
    );
    expect(effectiveAuthOrigin("OTHER=x\n", "http://127.0.0.1:3199")).toBe("http://127.0.0.1:3199");
  });

  it("strips a trailing slash so the startsWith marker cannot miss", () => {
    expect(effectiveAuthOrigin("AUTH_BASE_URL=http://localhost:3001/\n", "http://x")).toBe(
      "http://localhost:3001",
    );
  });
});

// A 307 to the WRONG origin cannot be a partial route table: the catch-all rejects `org` and calls
// notFound(), so it emits 404 and never a redirect. Only the real route redirects — meaning the route is
// serving and the harness simply expects the wrong origin. Polling that for 180s and then blaming the
// scan is what cost this session an hour; it is a configuration mismatch and should say so at once.
describe("authOriginMismatch", () => {
  it("recognises a 307 to a different origin as a config mismatch", () => {
    expect(authOriginMismatch(307, "http://localhost:3001/login", "http://127.0.0.1:3199")).toBe(
      true,
    );
  });

  it("is not triggered by the catch-all, which cannot redirect at all", () => {
    expect(authOriginMismatch(404, null, "http://127.0.0.1:3199")).toBe(false);
    expect(authOriginMismatch(200, null, "http://127.0.0.1:3199")).toBe(false);
  });

  it("is not triggered by the correct redirect", () => {
    expect(authOriginMismatch(307, "http://127.0.0.1:3199/login", "http://127.0.0.1:3199")).toBe(
      false,
    );
  });

  it("does not fire on a 307 with no Location, which is malformed rather than mismatched", () => {
    expect(authOriginMismatch(307, null, "http://127.0.0.1:3199")).toBe(false);
  });
});

// The parser must accept everything a real `.dev.vars` can hold, because anything it mishandles silently
// reinstates the 180s misdiagnosis this file exists to remove. `scripts/dev-preflight.mjs` strips
// surrounding quotes; a hand-rolled parser that did not would read `"http://localhost:3001"` — quotes
// included — and never match the redirect.
describe("effectiveAuthOrigin parses what .dev.vars actually contains", () => {
  it("strips surrounding quotes, as the repo's own .dev.vars parser does", () => {
    expect(effectiveAuthOrigin('AUTH_BASE_URL="http://localhost:3001"\n', "http://x")).toBe(
      "http://localhost:3001",
    );
    expect(effectiveAuthOrigin("AUTH_BASE_URL='http://localhost:3001'\n", "http://x")).toBe(
      "http://localhost:3001",
    );
  });

  it("ignores a COMMENTED-OUT key rather than reading it as configuration", () => {
    expect(effectiveAuthOrigin("# AUTH_BASE_URL=http://commented\n", "http://x")).toBe("http://x");
  });

  it("is not fooled by a key that merely ends with the name", () => {
    expect(effectiveAuthOrigin("NEXT_AUTH_BASE_URL=http://other\n", "http://x")).toBe("http://x");
  });

  it("finds the key wherever it sits in the file", () => {
    expect(effectiveAuthOrigin("A=1\nAUTH_BASE_URL=http://found\nB=2\n", "http://x")).toBe(
      "http://found",
    );
  });

  it("strips a trailing slash from the FALLBACK too, not just the value", () => {
    expect(effectiveAuthOrigin(null, "http://127.0.0.1:3199/")).toBe("http://127.0.0.1:3199");
  });
});

// `startsWith` cannot distinguish http://localhost:3001 from http://localhost:30010, so a genuinely
// mismatched origin sharing a prefix would go unflagged — and fall back to the 180s timeout this PR is
// removing. Compare ORIGINS.
describe("origin comparison is exact, not prefix-based", () => {
  it("does not treat a longer port as the expected origin", () => {
    expect(isRouteTableReady(307, "http://localhost:30010/login", "http://localhost:3001")).toBe(
      false,
    );
    expect(authOriginMismatch(307, "http://localhost:30010/login", "http://localhost:3001")).toBe(
      true,
    );
  });

  it("still accepts the genuine redirect", () => {
    expect(isRouteTableReady(307, "http://localhost:3001/login", "http://localhost:3001")).toBe(
      true,
    );
    expect(authOriginMismatch(307, "http://localhost:3001/login", "http://localhost:3001")).toBe(
      false,
    );
  });

  it("treats an unparseable or relative Location as 'keep polling', never as a mismatch", () => {
    // Conservative on purpose: a false fast-fail would replace a slow correct answer with a fast wrong
    // one, which is a worse trade than the timeout it avoids.
    expect(authOriginMismatch(307, "/login", "http://localhost:3001")).toBe(false);
    expect(isRouteTableReady(307, "/login", "http://localhost:3001")).toBe(false);
  });
});

// ── Which of the two scan failures happened ────────────────────────────────────────────────────────
// A CI failure on 2026-08-01 reported `last probe: 404 (no Location)` for the full 180s: the catch-all
// answered throughout, so the deep route never served. But "never served" has two very different causes
// and the message cannot tell them apart —
//
//   · the SCAN never reached the route (next dev is still walking src/app), or
//   · the scan finished and the route registered, but it never compiled/served.
//
// One is a slow filesystem walk, the other is a compile problem. They point at different subsystems, and
// guessing between them is how a flake stays open. The gate now reports which it saw.
describe("awaitRouteScan reports WHY it gave up", () => {
  const route = ["org", "[orgId]"];
  const listed = 'type Routes = "/org/[orgId]" | "/other"';

  it("says `listed` when the route reaches the types file", async () => {
    expect(await awaitRouteScan(async () => listed, route, { budgetMs: 50, sleepMs: 1 })).toBe(
      "listed",
    );
  });

  it("says `absent` when the types file never appears — the gate was INERT", async () => {
    // Not a failure: the file is undocumented and version-dependent, so this degrades to "probe anyway".
    // But it means the gate contributed nothing, which is worth knowing before blaming the scan.
    const missing = async () => {
      throw new Error("ENOENT");
    };
    expect(await awaitRouteScan(missing, route, { budgetMs: 30, sleepMs: 1 })).toBe("absent");
  });

  it("says `missing-route` when the file is readable but never lists the route", async () => {
    // The genuinely diagnostic case: next dev IS writing its route table and this route is not in it, so
    // the scan really did not reach it within the budget.
    const other = async () => 'type Routes = "/other"';
    expect(await awaitRouteScan(other, route, { budgetMs: 30, sleepMs: 1 })).toBe("missing-route");
  });

  it("returns as soon as the route appears, rather than burning the budget", async () => {
    let calls = 0;
    const eventually = async () => {
      calls += 1;
      return calls < 3 ? 'type Routes = "/other"' : listed;
    };
    expect(await awaitRouteScan(eventually, route, { budgetMs: 5_000, sleepMs: 1 })).toBe("listed");
    expect(calls).toBe(3);
  });
});
