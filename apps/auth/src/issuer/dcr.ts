// Open-DCR redirect-URI policy. The provider's Dynamic Client Registration (/register) is open to public
// clients (any MCP client registers itself); without this callback it would store almost any redirect_uri
// (the provider blocks only javascript:/data:/… — NOT plain-http-to-a-remote-host), an open-redirect /
// consent-phishing vector. This callback is the policy gate that decides which redirect_uris may register.
//
// POLICY (MCP authorization spec — redirect URIs MUST be "localhost or HTTPS"):
//   • http LOOPBACK — 127.0.0.0/8, ::1, or localhost, ANY port/path (RFC 8252 native clients: Claude Code,
//     VS Code, Codex, Cline, Zed, Continue, the first-party CLI). Loopback carries no phishing surface —
//     the code can only reach the user's own machine, and it's PKCE-bound.
//   • remote https — but ONLY to an ALLOWLIST of the known MCP-vendor callback hosts. Open https DCR would
//     let anyone self-register https://evil.com and phish a logged-in user through consent (confused
//     deputy); the allowlist removes that entire class. Web MCP clients not on the list use a first-party
//     `whk_` bearer token; CIMD (domain-proven identity) is the roadmap to lift the allowlist safely.
// Everything else is rejected: plain http to a non-loopback host, our OWN origins (not on the allowlist),
// custom schemes (cursor:// — Cursor desktop uses a bearer token), and non-URLs.
//
// Pure + I/O-free → unit-tested; wired into oauthIssuerConfig.clientRegistrationCallback. All checks read
// `url.hostname` (the parsed host), which defeats userinfo-confusion (`https://claude.ai@evil.com` →
// hostname `evil.com` → rejected) and keeps punycode homoglyphs distinct; IPv4/IPv6 shorthands that
// WHATWG-canonicalize to a true loopback are accepted (parity with the provider's isLoopbackUri).

/**
 * The known MCP-vendor https callback hosts allowed to self-register a remote redirect. Matched on the
 * exact parsed hostname (lowercased, trailing dot stripped). Keep in sync with the docs; adding a host
 * here is the reviewed way to onboard a new web MCP client until CIMD lands.
 */
export const ALLOWED_HTTPS_REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  "claude.ai", // Claude Desktop / claude.ai / mobile custom connectors
  "claude.com", // Claude connector (.com variant)
  "cursor.com", // Cursor web / cloud agents
  "www.cursor.com",
  "vscode.dev", // VS Code web redirect
  "insiders.vscode.dev",
]);

/** True for a loopback host per RFC 8252 (127.0.0.0/8, ::1, localhost) — mirrors the provider. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, "").toLowerCase();
  if (host === "localhost") return true;
  if (host === "::1" || host === "[::1]") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Classify a redirect_uri: an http loopback, an allowlisted-vendor https callback, or neither. */
function classifyRedirectUri(uri: string): "loopback" | "https" | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return "loopback";
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (url.protocol === "https:" && ALLOWED_HTTPS_REDIRECT_HOSTS.has(host)) return "https";
  return null;
}

/**
 * May this redirect_uri be registered? True for an http loopback (any port/path) or an allowlisted-vendor
 * https callback. This is the POLICY gate — used by DCR registration AND the consent-flow re-validation.
 */
export function isRegisterableRedirectUri(uri: string): boolean {
  return classifyRedirectUri(uri) !== null;
}

/**
 * Is this an http LOOPBACK redirect (the only kind that uses the /consent/complete server-302 bounce, per
 * Private Network Access)? Deliberately NARROW — never true for https/remote — so the completion bounce
 * can never be coerced into an own-origin open redirect to an arbitrary host.
 */
export function isHttpLoopbackRedirect(uri: string): boolean {
  return classifyRedirectUri(uri) === "loopback";
}

/** An OAuth registration-error result; returning it from the callback REJECTS the registration. */
export interface RegistrationRejection {
  code: string;
  description: string;
  status: number;
}

/**
 * Validate a DCR client's metadata. Returns a rejection for a missing/empty redirect_uris or any
 * disallowed entry; undefined to allow. (The provider treats a returned result as a rejection, void/
 * undefined as acceptance.)
 */
export function validateClientRegistration(
  clientMetadata: Record<string, unknown>,
): RegistrationRejection | undefined {
  const redirectUris = clientMetadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return {
      code: "invalid_redirect_uri",
      description: "at least one redirect_uri is required",
      status: 400,
    };
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isRegisterableRedirectUri(uri)) {
      return {
        code: "invalid_redirect_uri",
        description:
          "every redirect_uri must be an http loopback (127.0.0.1, ::1, or localhost) or an https callback for a supported MCP client",
        status: 400,
      };
    }
  }
  return undefined;
}
