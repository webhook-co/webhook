import { isOAuthCredential, type StoredCredential } from "../config/schema.js";
import type { CredentialStore } from "../config/store.js";
import { ENV_AUTH_URL_VAR, resolveAuthBaseUrl } from "./endpoints.js";
import { createTokenManager } from "./token-manager.js";

// The bridge between a stored credential and the api-client/tunnel bearer. An API-key credential is a
// static bearer with no refresh. An OAuth credential gets a token manager: the bearer is resolved
// PROACTIVELY (refresh if at/near expiry, persisting the rotated credential) and the reactive 401 refresh
// hook is handed to the api-client. One choke point so every authed surface (reads, whoami, replay, the
// listen tunnel) refreshes identically.

export interface BoundAuth {
  /** The bearer to send now (proactively refreshed for an OAuth credential at/near expiry). */
  readonly bearer: string;
  /** The api-client's reactive 401 refresh hook — present only for an OAuth credential. */
  readonly refreshAuth?: () => Promise<string | null>;
}

export async function bindAuth(deps: {
  cred: StoredCredential;
  profile: string;
  store: CredentialStore;
  fetch: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<BoundAuth> {
  if (!isOAuthCredential(deps.cred)) return { bearer: deps.cred.apiKey };
  const manager = createTokenManager({
    cred: deps.cred,
    profile: deps.profile,
    store: deps.store,
    fetch: deps.fetch,
    authBaseUrl: resolveAuthBaseUrl({ env: deps.env?.[ENV_AUTH_URL_VAR] }),
  });
  return { bearer: await manager.currentBearer(), refreshAuth: manager.refreshAuth };
}
