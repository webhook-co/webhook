import { PROVIDER_DOMAINS } from "@webhook-co/ui";

// The favicon-proxy route's pure helpers (the route handler in app/api/provider-icon/route.ts is a thin
// shell around these). The route exists so the dashboard can show a real brand logo for the brands Simple
// Icons has dropped over trademark policy — WITHOUT a third-party request at render time: the browser only
// ever talks to our origin, we fetch Google's favicon service SERVER-SIDE once, and edge-cache it hard. Two
// properties are load-bearing and tested here: (1) the domain is ALLOWLISTED against PROVIDER_DOMAINS so
// this can never be an open proxy / SSRF vector, and (2) the upstream host is FIXED (the domain is only ever
// an encoded query param).

/** The exact set of domains we will proxy a favicon for — the values of the provider→domain map. */
const ALLOWED_ICON_DOMAINS: ReadonlySet<string> = new Set(Object.values(PROVIDER_DOMAINS));

/** True IFF `domain` is an exact allowlisted provider domain (never a substring/host-confusion match). */
export function isAllowedIconDomain(domain: string | null): domain is string {
  return domain !== null && ALLOWED_ICON_DOMAINS.has(domain);
}

/**
 * The FIXED upstream favicon URL for an (already-allowlisted) domain. The host is a constant; the domain is
 * only ever a url-encoded query value, so it can never redirect the fetch to another host (no SSRF). `sz=64`
 * is 4× the 16px dropdown tile, so it downscales crisply on retina.
 */
export function upstreamFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

/**
 * Cache the proxied favicon for ~a year, immutably. A provider's favicon is effectively static; `immutable`
 * lets the browser skip revalidation entirely, and the same header makes the Cloudflare edge cache it, so
 * Google is hit at most once per domain per PoP rather than once per render. A rare rebrand self-heals within
 * the year (or via a manual cache purge).
 */
export const ICON_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Injected edge-cache + fetch seam (the route wires `caches.default` + global `fetch`; tests mock them). */
export interface IconFetchDeps {
  readonly fetch: (url: string) => Promise<Response>;
  readonly cacheMatch?: (key: Request) => Promise<Response | undefined>;
  readonly cachePut?: (key: Request, res: Response) => Promise<void>;
}

/**
 * Serve the proxied, edge-cached favicon for `?domain=…`. An unknown domain 404s WITHOUT any upstream fetch
 * (allowlist gate). On a cache hit the stored response is returned (no upstream fetch); on a miss we fetch
 * Google's favicon service SERVER-SIDE, force `image/png` + `nosniff` (so a surprise SVG/HTML body can never
 * be active content on our origin), cache it immutably, and return it. Any upstream failure → 404 (the
 * caller's background-image simply doesn't paint, leaving the monogram — no broken image).
 */
export async function serveProviderIcon(
  requestUrl: string,
  deps: IconFetchDeps,
): Promise<Response> {
  const domain = new URL(requestUrl).searchParams.get("domain");
  if (!isAllowedIconDomain(domain)) return new Response("Not found", { status: 404 });

  const cacheKey = new Request(`https://provider-icon.internal/${domain}`);
  const cached = deps.cacheMatch ? await deps.cacheMatch(cacheKey) : undefined;
  if (cached) return cached;

  let upstream: Response;
  try {
    upstream = await deps.fetch(upstreamFaviconUrl(domain));
  } catch {
    return new Response(null, { status: 404 });
  }
  if (!upstream.ok) return new Response(null, { status: 404 });

  const body = await upstream.arrayBuffer();
  const res = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": ICON_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
  if (deps.cachePut) await deps.cachePut(cacheKey, res.clone());
  return res;
}
