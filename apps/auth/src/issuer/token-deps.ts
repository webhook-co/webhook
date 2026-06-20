// A2b-2b — wires token-core's injected AuthCodeDeps to the REAL provider + Lane B + the refresh store.
// This is the I/O glue (it talks to the OAuth provider, the DB, and Secrets Store), so it's not unit-
// tested; it's typecheck- + build:cf- + deploy:dry-verified, and the one piece of pure logic worth
// testing — sanitizing the provider's token-error code — is extracted as `mapProviderTokenError`.
//
// Option B (ADR-0024): the provider owns /oauth/token (opaque, server-side); Lane C's /token subrequests
// it (PKCE validated in-library), unwraps the opaque grant, mints a first-party whk_ + a ~90d refresh
// handle, then revokes the now-vestigial provider grant. Audience/scope/tenancy invariants live in
// token-core; this only supplies the seams.

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { CAPABILITY_REGISTRY } from "@webhook-co/contract";
import {
  API_RESOURCE,
  MCP_RESOURCE,
  createClient,
  createCredentialHasherFromBase64,
  isOrgMember,
  mintRefreshToken,
  mintScopedKey,
  revokeGrant,
} from "@webhook-co/db";
import { b64ToBytes, importAuditKey, readSecretBinding } from "@webhook-co/shared";

import { oauthIssuerConfig } from "./oauth-config";
import { mapProviderTokenError } from "./token-error";
import type { AuthCodeDeps, ConsentProps } from "./token-core";
import type { TokenEnv } from "../runtime/env";

/** 24h whk_ key (the C↔D contract's expires_in); ~90d opaque refresh handle. */
const KEY_TTL_SECONDS = 86_400;
const REFRESH_TTL_SECONDS = 7_776_000;
// ~90d absolute grant ceiling = the "grant lifetime" the consent screen advertises. The grant's expiry
// caps the refresh chain (consumeRefreshToken rejects a grant past expiry), so a perpetually-rotated
// handle still terminates at 90d → re-login. Without it the chain would renew forever.
const GRANT_TTL_SECONDS = REFRESH_TTL_SECONDS;
const DEFAULT_PENDING_INTERVAL = 5;

/** The capability scopes a mint may ever contain — the SoT (matches oauth-config's discovery set). */
const CAPABILITY_SCOPES = [
  ...new Set([...CAPABILITY_REGISTRY.values()].map((c) => c.auth.scope)),
].sort();

// getOAuthApi needs a full OAuthProviderOptions, but the helpers we use (unwrapToken/revokeGrant) work off
// OAUTH_KV + the token encryption only and never invoke defaultHandler — so a never-called 404 stub
// completes the options without pulling the OpenNext handler into this module.
const HELPERS_DEFAULT_HANDLER = { fetch: async () => new Response(null, { status: 404 }) };

export interface TokenDeps {
  authCode: AuthCodeDeps;
  /** Drain the per-request webhook_app pool (call via ctx.waitUntil after the response). */
  close: () => Promise<void>;
}

/**
 * Build the auth-code redemption deps for one /token request. `requestUrl` is the incoming request URL —
 * the provider's /oauth/token is subrequested same-origin from it (global_fetch_strictly_public loops it
 * back through the edge to the provider mount).
 */
export async function makeTokenDeps(env: TokenEnv, requestUrl: string): Promise<TokenDeps> {
  const [pepper, auditRaw] = await Promise.all([
    readSecretBinding(env.CREDENTIAL_PEPPER),
    readSecretBinding(env.AUDIT_CHAIN_HMAC_KEY),
  ]);
  const hasher = createCredentialHasherFromBase64(pepper);
  const auditKey = await importAuditKey(b64ToBytes(auditRaw));
  const helpers = getOAuthApi(
    { ...oauthIssuerConfig, defaultHandler: HELPERS_DEFAULT_HANDLER },
    env as never,
  );
  const providerTokenEndpoint = new URL("/oauth/token", requestUrl);
  // Pool created LAST: nothing after it can throw before `close` is wired into the returned deps, so the
  // caller's waitUntil(close()) always drains it.
  const app = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 5 });

  const authCode: AuthCodeDeps = {
    allowedAudiences: [API_RESOURCE, MCP_RESOURCE],
    allowedScopes: CAPABILITY_SCOPES,
    keyTtlSeconds: KEY_TTL_SECONDS,
    defaultPendingInterval: DEFAULT_PENDING_INTERVAL,

    exchangeAuthCode: async (req) => {
      const res = await fetch(providerTokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: req.code,
          code_verifier: req.code_verifier,
          redirect_uri: req.redirect_uri,
          client_id: req.client_id,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        error?: string;
      };
      if (res.ok && typeof json.access_token === "string" && json.access_token.length > 0) {
        return { ok: true as const, opaque: json.access_token };
      }
      // A non-2xx with no parseable error, or a 2xx without an access_token, is a server-side fault.
      if (res.ok || json.error === undefined) {
        return { ok: false as const, error: "server_error" as const };
      }
      return { ok: false as const, error: mapProviderTokenError(json.error) };
    },

    unwrapToken: async (opaque) => {
      const summary = await helpers.unwrapToken<ConsentProps>(opaque);
      return summary ? { providerGrantId: summary.grantId, props: summary.grant.props } : null;
    },

    revokeProviderGrant: (providerGrantId, userId) => helpers.revokeGrant(providerGrantId, userId),

    rollbackMint: async (grantId, orgId) => {
      await revokeGrant(app, { orgId, grantId, reason: "issuance_rollback" }, auditKey);
    },

    isOrgMember: (userId, orgId) => isOrgMember(app, userId, orgId),

    mintScopedKey: (input) =>
      mintScopedKey(
        app,
        { ...input, authMethod: "pkce_loopback", grantTtlSeconds: GRANT_TTL_SECONDS },
        hasher,
        auditKey,
      ),

    issueRefreshToken: async (grantId, orgId, audience) => {
      const minted = await mintRefreshToken(
        app,
        { orgId, grantId, audience, ttlSeconds: REFRESH_TTL_SECONDS },
        hasher,
      );
      return minted.plaintext;
    },

    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };

  return { authCode, close: () => app.end() };
}
