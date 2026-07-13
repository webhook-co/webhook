import { describe, expect, it, vi } from "vitest";

// OpenNext's dev initialiser runs at next.config module scope and wants a Cloudflare dev context. Stub it so
// the config can be IMPORTED and its `headers()` actually CALLED — a behavioural assertion beats a source-text
// grep, because it proves the rules are wired, not merely typed somewhere in the file.
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: () => {} }));

import nextConfig from "../next.config";
import { AUTHENTICATED_ROUTE_SOURCES } from "./security-headers";

// Authenticated HTML must never become a stored response.
//
// This used to be true only by accident: every gated route reads cookies(), so Next renders it dynamically and
// emits no-store on its own. Nothing pinned that. And `Clear-Site-Data: "cache"` on logout — which purged the
// whole registrable domain and would have cleaned up after a mistake — was removed for costing ~25 seconds of
// every logout. So the invariant now has to hold on its own, and this is what holds it.
//
// The failure it exists to catch is mundane and plausible: someone adds `export const revalidate = 60` to a
// dashboard route for performance, and one tenant's org page becomes a cacheable, servable response.
describe("next.config headers()", () => {
  // next.config default-exports a PHASE function (Next calls it with the build phase), so resolve the real
  // production config the same way Next does rather than reaching for a plain object that isn't there.
  async function rules() {
    const config = nextConfig("phase-production-build");
    const headers = config.headers;
    if (!headers) {
      throw new Error("next.config defines no headers() — the security headers are not wired");
    }
    return headers();
  }

  const cacheControlFor = (
    rule: { headers: { key: string; value: string }[] } | undefined,
  ): string | undefined => rule?.headers.find((h) => h.key === "Cache-Control")?.value;

  it("sends no-store on every authenticated route", async () => {
    const all = await rules();

    for (const source of AUTHENTICATED_ROUTE_SOURCES) {
      const rule = all.find((r) => r.source === source);
      expect(rule, `no header rule is wired for the authenticated route ${source}`).toBeDefined();
      expect(cacheControlFor(rule)).toContain("no-store");
      expect(cacheControlFor(rule)).toContain("private");
    }
  });

  it("still applies the security headers (CSP) to everything", async () => {
    const all = await rules();
    const catchAll = all.find((r) => r.source === "/(.*)");

    expect(catchAll).toBeDefined();
    expect(catchAll?.headers.map((h) => h.key)).toContain("Content-Security-Policy");
  });

  // The reason no-store is an ALLOWLIST and not `/(.*)`: telling the browser not to store the immutable,
  // content-hashed JS/CSS bundles would be a large self-inflicted performance regression — precisely the kind
  // of cost we just removed from logout. So no no-store rule may be broad enough to swallow /_next/static.
  it("never tells the browser to stop caching the static bundles", async () => {
    const all = await rules();

    for (const rule of all) {
      if (!cacheControlFor(rule)?.includes("no-store")) continue;
      expect(rule.source).not.toBe("/(.*)");
      expect(rule.source).not.toContain("_next");
    }
  });
});
