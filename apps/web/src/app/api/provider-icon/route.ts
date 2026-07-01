import { getCloudflareContext } from "@opennextjs/cloudflare";

import { type IconStore, serveProviderIcon } from "@/server/provider-icon";

// dal-gate-allow: public favicon proxy — serves only public brand favicons for an ALLOWLISTED set of
// provider domains; owns/reads NO tenant, session, or org-scoped data (ADR-0023), so it is intentionally
// unauthenticated (an <img>/background-image resource load can't carry auth anyway).

// Fetches an upstream favicon + edge-caches it per request (cache miss); never statically optimized.
export const dynamic = "force-dynamic";

/** Minimal shape of the R2 bucket binding used here (get bytes / put bytes). */
interface R2Like {
  get: (key: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>;
  put: (key: string, body: ArrayBuffer) => Promise<unknown>;
}

/**
 * Same-origin, edge-cached favicon proxy for logo-less providers (see @webhook-co/ui ProviderLogo +
 * PROVIDER_DOMAINS). PUBLIC (favicons are public brand marks) but ALLOWLISTED to our known provider domains
 * inside `serveProviderIcon` — never an open proxy. The browser only ever talks to this origin, so no
 * third-party request is made at render time and the `img-src 'self'` CSP is unchanged.
 */
export async function GET(request: Request): Promise<Response> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;

  // The durable R2 store (best-effort): resolved via OpenNext's Cloudflare context. Absent in local dev
  // without a bound bucket → serveProviderIcon just skips the store and uses the edge cache + upstream.
  let store: IconStore | undefined;
  try {
    const { env } = await getCloudflareContext({ async: true });
    const bucket = (env as Record<string, unknown>).R2_PROVIDER_ICONS as R2Like | undefined;
    if (bucket) {
      store = {
        get: async (key) => {
          const obj = await bucket.get(key);
          return obj ? await obj.arrayBuffer() : null;
        },
        put: async (key, body) => {
          await bucket.put(key, body);
        },
      };
    }
  } catch {
    // no Cloudflare context (e.g. non-workerd env) → run without the durable store
  }

  return serveProviderIcon(request.url, {
    fetch: (url) => fetch(url),
    cacheMatch: cache ? async (key) => (await cache.match(key)) ?? undefined : undefined,
    cachePut: cache ? (key, res) => cache.put(key, res) : undefined,
    store,
  });
}
