import { InvalidAuthUrlError } from "../errors.js";

// The OAuth issuer (auth.webhook.co) + its endpoint paths. The paths are HARDCODED (not read from the
// RFC 8414 discovery doc) on purpose: the provider's discovery `token_endpoint` points at the opaque
// `/oauth/token`, whereas the CLI must use Lane C's FROZEN `/token` (the one that returns the `whk_`
// FrozenTokenBody). All paths are mounted at the issuer ROOT (issuer-handler.ts dispatches by pathname).

/** The canonical hosted OAuth issuer. Overridable via `--auth-url` / `WBHK_AUTH_URL` (self-host / dev). */
export const DEFAULT_AUTH_BASE_URL = "https://auth.webhook.co";

/** Env var overriding the OAuth issuer origin (sticky alternative to a per-invocation flag). */
export const ENV_AUTH_URL_VAR = "WBHK_AUTH_URL";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Resolve + validate the OAuth issuer origin: `--auth-url` flag › `WBHK_AUTH_URL` › the default. MUST be
 * https:// (http:// only for loopback dev) — the flow carries auth codes + tokens, so a plaintext or
 * attacker-chosen issuer would leak credentials. No query/fragment, no embedded userinfo (defeats
 * `https://real@evil` confusion); the normalized origin+path (trailing slash stripped) is returned.
 */
export function resolveAuthBaseUrl(opts: { flag?: string; env?: string }): string {
  const raw = opts.flag ?? opts.env ?? DEFAULT_AUTH_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidAuthUrlError(raw);
  }
  const loopbackHttpOk = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttpOk) throw new InvalidAuthUrlError(raw);
  if (url.search !== "" || url.hash !== "") throw new InvalidAuthUrlError(raw);
  // Embedded userinfo would be dropped by origin+pathname anyway, but reject it outright so a misleading
  // `https://auth.webhook.co@evil.example` form fails loudly rather than silently resolving to evil.example.
  if (url.username !== "" || url.password !== "") throw new InvalidAuthUrlError(raw);
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/** The OAuth endpoint URLs for an issuer origin. */
export interface OAuthEndpoints {
  readonly register: string; // DCR (RFC 7591, JSON), provider-owned
  readonly authorize: string; // GET, browser (session-gated → consent)
  readonly token: string; // POST form — Lane C frozen FrozenTokenBody endpoint
  readonly deviceAuthorization: string; // POST form (RFC 8628)
  readonly revoke: string; // POST form (RFC 7009)
}

export function oauthEndpoints(baseUrl: string): OAuthEndpoints {
  return {
    register: `${baseUrl}/register`,
    authorize: `${baseUrl}/authorize`,
    token: `${baseUrl}/token`,
    deviceAuthorization: `${baseUrl}/device_authorization`,
    revoke: `${baseUrl}/revoke`,
  };
}
