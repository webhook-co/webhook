import { serveProviderIcon } from "@/server/provider-icon";

// dal-gate-allow: public favicon proxy — serves only public brand favicons for an ALLOWLISTED set of
// provider domains; owns/reads NO tenant, session, or org-scoped data (ADR-0023), so it is intentionally
// unauthenticated (an <img>/background-image resource load can't carry auth anyway).

// Fetches an upstream favicon + edge-caches it per request (cache miss); never statically optimized.
export const dynamic = "force-dynamic";

/**
 * Same-origin, edge-cached favicon proxy for logo-less providers (see @webhook-co/ui ProviderLogo +
 * PROVIDER_DOMAINS). PUBLIC (favicons are public brand marks) but ALLOWLISTED to our known provider domains
 * inside `serveProviderIcon` — never an open proxy. The browser only ever talks to this origin, so no
 * third-party request is made at render time and the `img-src 'self'` CSP is unchanged.
 */
export async function GET(request: Request): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
  return serveProviderIcon(request.url, {
    fetch: (url) => fetch(url),
    cacheMatch: cache ? async (key) => (await cache.match(key)) ?? undefined : undefined,
    cachePut: cache ? (key, res) => cache.put(key, res) : undefined,
  });
}
