// Resolve which proxy (if any) to use for a target URL, from the environment — the de-facto curl/wget
// convention. Pure + env-injected so it's unit-tested; the actual agent wiring (the `ws` tunnel) lives in
// io.ts (coverage-excluded). The api-client's `fetch` proxy is handled by the RUNTIME, not here: the
// bun-compiled binary honors HTTP(S)_PROXY natively, and the npm/Node path honors it with
// `NODE_USE_ENV_PROXY=1` (Node 24.5+). `ws`, though, never auto-proxies, so the tunnel needs this.

/**
 * The proxy URL to use for `targetUrl`, or undefined when none applies. HTTPS_PROXY (→ https/wss),
 * HTTP_PROXY (→ http/ws), ALL_PROXY as a fallback; NO_PROXY (`*`, or a comma-list of dot-bounded host
 * suffixes) excludes a host. Env names are matched case-insensitively (UPPER then lower). Ports/CIDRs in
 * NO_PROXY are not interpreted (host-suffix match only — the common case).
 */
export function resolveProxy(
  targetUrl: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return undefined;
  }
  const get = (name: string): string | undefined => {
    // First NON-EMPTY of UPPER then lower (so a whitespace-only UPPER doesn't shadow a real lowercase var).
    for (const v of [env[name.toUpperCase()], env[name.toLowerCase()]]) {
      if (v !== undefined && v.trim().length > 0) return v.trim();
    }
    return undefined;
  };

  const noProxy = get("no_proxy");
  if (noProxy !== undefined) {
    if (noProxy === "*") return undefined; // bypass all
    const host = url.hostname.toLowerCase();
    const excluded = noProxy
      .split(",")
      .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
      .filter((e) => e.length > 0)
      .some((bare) => host === bare || host.endsWith(`.${bare}`));
    if (excluded) return undefined;
  }

  const secure = url.protocol === "https:" || url.protocol === "wss:";
  return (secure ? get("https_proxy") : get("http_proxy")) ?? get("all_proxy");
}
