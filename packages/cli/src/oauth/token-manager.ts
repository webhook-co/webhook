import type { OAuthCredential } from "../config/schema.js";
import type { CredentialStore } from "../config/store.js";
import { oauthEndpoints } from "./endpoints.js";
import { refreshAccessToken, toOAuthCredential } from "./token-client.js";

// The OAuth refresh coordinator for one command invocation. It owns a single OAuth credential and keeps a
// valid access token in front of the api-client: PROACTIVELY (refresh just before expiry, so a request
// never rides a token that expires mid-flight) and REACTIVELY (the api-client's 401 hook forces a refresh).
// Both go through ONE single-flight refresh, because the issuer's refresh token is single-use + ALWAYS
// rotates (consume-before-mint) — two concurrent refreshes would burn the handle and `invalid_grant` the
// second. The rotated credential is persisted (atomically, by the store) before the new bearer is handed
// out. All wire I/O is over the injected `fetch`, so the whole manager is fake-fetch testable.

/** Refresh the access token this many ms BEFORE its expiry, so a request never rides a just-expired key. */
export const REFRESH_SKEW_MS = 60_000;

export interface TokenManager {
  /** The bearer to use now — refreshes proactively when the access token is at/within the skew margin. */
  currentBearer(): Promise<string>;
  /** The api-client's reactive 401 hook: force a single-flight refresh, return the new bearer (or throw
   *  an OAuthError → re-login). Shares the in-flight refresh with `currentBearer`. */
  refreshAuth(): Promise<string | null>;
}

export interface TokenManagerDeps {
  readonly cred: OAuthCredential;
  readonly profile: string;
  /** The store the rotated credential is persisted into (only `set` is used). */
  readonly store: Pick<CredentialStore, "set">;
  readonly fetch: typeof fetch;
  /** The resolved issuer origin (`oauthEndpoints(authBaseUrl).token` is the refresh endpoint). */
  readonly authBaseUrl: string;
  /** Clock for the proactive check + the synthesized `expiresAt` (real `Date.now` in prod). */
  readonly now?: () => number;
  /** Proactive refresh margin before expiry (default `REFRESH_SKEW_MS`). */
  readonly skewMs?: number;
}

export function createTokenManager(deps: TokenManagerDeps): TokenManager {
  let cred = deps.cred;
  let inflight: Promise<string> | null = null;
  const now = deps.now ?? ((): number => Date.now());
  const skewMs = deps.skewMs ?? REFRESH_SKEW_MS;
  const tokenUrl = oauthEndpoints(deps.authBaseUrl).token;

  async function doRefresh(): Promise<string> {
    const body = await refreshAccessToken({ fetch: deps.fetch }, tokenUrl, {
      refreshToken: cred.oauth.refreshToken,
      clientId: cred.oauth.clientId,
      resource: cred.oauth.audience,
    });
    const rotated = toOAuthCredential(body, {
      authMethod: cred.oauth.authMethod,
      clientId: cred.oauth.clientId,
      now: now(),
    });
    // Persist BEFORE returning the new bearer. The issuer already consumed the old refresh to mint this
    // one, so a crash between the 200 above and this commit leaves the old handle dead + the new one
    // unpersisted → the next run sends the dead handle → invalid_grant → forced clean re-login (routed).
    // A throw here therefore propagates rather than handing out an unpersisted token.
    await deps.store.set(rotated, deps.profile);
    cred = rotated;
    return rotated.oauth.accessKey;
  }

  function refresh(): Promise<string> {
    if (inflight === null) {
      inflight = doRefresh().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    async currentBearer() {
      return now() >= cred.oauth.expiresAt - skewMs ? refresh() : cred.oauth.accessKey;
    },
    refreshAuth() {
      // Never resolves to `null` here (a hard failure throws an OAuthError → re-login); the nullable is
      // the api-client hook contract, where `null` means "the caller has no refresh, surface the 401".
      return refresh();
    },
  };
}
