import type { LoopbackServer } from "../context.js";
import { OAuthError } from "../errors.js";
import { sanitizeControl } from "../output/safe-text.js";
import { registerClient } from "./dcr.js";
import { oauthEndpoints } from "./endpoints.js";
import { generatePkce, randomState } from "./pkce.js";
import { exchangeAuthCode, type FrozenTokenBody } from "./token-client.js";

// The RFC 8252 §8.3 loopback authorization-code + PKCE flow — the default interactive `wbhk login`. We
// start a localhost server on the 127.0.0.1 IP literal (an ephemeral port), DCR-register a public client
// for THAT exact `http://127.0.0.1:<port>/callback` (the issuer exact-matches the redirect_uri, so the
// registration is per-login — the port varies), open the browser to `/authorize` with an S256 PKCE
// challenge + a CSRF `state`, capture the redirect on the loopback, verify `state`, and exchange the code.
// The server + browser are injected (io seams) so everything but the real browser round-trip is tested.

export interface LoopbackLoginDeps {
  readonly fetch: typeof fetch;
  /** The resolved issuer origin. */
  readonly authBaseUrl: string;
  /** Space-separated capability scopes to request. */
  readonly scope: string;
  /** The target audience (RFC 8707) — the api origin. */
  readonly resource: string;
  /** Start the loopback redirect server (an io seam; bound to 127.0.0.1 on an ephemeral port). */
  readonly startLoopbackServer: () => Promise<LoopbackServer>;
  /** Best-effort: open the authorize URL in the user's browser (an io seam). */
  readonly openBrowser?: (url: string) => Promise<void>;
  /** Emit the user-facing "opening your browser / visit this URL" instructions (stderr in prod). */
  readonly emit: (line: string) => void;
}

function buildAuthorizeUrl(
  authorizeEndpoint: string,
  opts: {
    clientId: string;
    redirectUri: string;
    challenge: string;
    state: string;
    scope: string;
    resource: string;
  },
): string {
  const url = new URL(authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256"); // the issuer is S256-only (plain forbidden)
  url.searchParams.set("state", opts.state);
  url.searchParams.set("scope", opts.scope);
  url.searchParams.set("resource", opts.resource);
  return url.toString();
}

/**
 * Run the loopback flow to completion: returns the minted token body + the (per-login) client id, or
 * throws an OAuthError (state mismatch / a redirect `error` / a missing code / a `/token` failure). The
 * loopback server is ALWAYS torn down.
 */
export async function loopbackLogin(
  deps: LoopbackLoginDeps,
): Promise<{ body: FrozenTokenBody; clientId: string }> {
  const endpoints = oauthEndpoints(deps.authBaseUrl);
  const server = await deps.startLoopbackServer();
  try {
    const redirectUri = `http://127.0.0.1:${server.port}/callback`;
    // Register a fresh public client for THIS redirect URI — the issuer exact-matches it at /authorize,
    // and the loopback port changes per login, so a cached client_id can't be reused here.
    const { clientId } = await registerClient({ fetch: deps.fetch }, endpoints.register, [
      redirectUri,
    ]);
    const pkce = await generatePkce();
    const state = randomState();
    const authorizeUrl = buildAuthorizeUrl(endpoints.authorize, {
      clientId,
      redirectUri,
      challenge: pkce.challenge,
      state,
      scope: deps.scope,
      resource: deps.resource,
    });

    deps.emit(`opening your browser to authorize. if it doesn't open, visit:\n  ${authorizeUrl}\n`);
    if (deps.openBrowser !== undefined) {
      try {
        await deps.openBrowser(authorizeUrl);
      } catch {
        /* no browser — the printed URL is the fallback */
      }
    }

    const params = await server.waitForCallback();
    // CSRF: the redirect MUST echo the exact state we sent, or the callback isn't ours — reject before
    // touching the code. (Checked first, so a forged redirect can't even reach the token exchange.)
    if (params.get("state") !== state) throw new OAuthError("state_mismatch");
    const error = params.get("error");
    // `error` is server/redirect-controlled → strip control bytes before it can reach stderr.
    if (error !== null) throw new OAuthError(sanitizeControl(error));
    const code = params.get("code");
    if (code === null || code === "") throw new OAuthError("missing_authorization_code");

    const body = await exchangeAuthCode({ fetch: deps.fetch }, endpoints.token, {
      code,
      codeVerifier: pkce.verifier,
      redirectUri,
      clientId,
      resource: deps.resource,
    });
    return { body, clientId };
  } finally {
    server.close();
  }
}
