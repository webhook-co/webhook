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
import {
  API_RESOURCE,
  MCP_RESOURCE,
  consumeRefreshToken,
  createClient,
  createCredentialHasherFromBase64,
  isOrgMember,
  listApiKeysForGrant,
  mintKeyForGrant,
  mintRefreshToken,
  mintScopedKey,
  revokeGrant,
} from "@webhook-co/db";
import { b64ToBytes, importAuditKey, readSecretBinding } from "@webhook-co/shared";

import { makeDeviceStoreDeps } from "./device-deps";
import { pollDeviceCode } from "./device-store";
import type { DeviceTokenDeps } from "./device-token-core";
import { GRANT_TTL_SECONDS, HELPERS_DEFAULT_HANDLER, KEY_TTL_SECONDS } from "./issuer-constants";
import { CAPABILITY_SCOPES, oauthIssuerConfig } from "./oauth-config";
import { mapProviderTokenError } from "./token-error";
import type { AuthCodeDeps, ConsentProps, RefreshDeps } from "./token-core";
import type { TokenEnv } from "../runtime/env";

// The opaque refresh handle lives as long as the grant ceiling (~90d): the grant's expiry caps the refresh
// chain (consumeRefreshToken rejects a grant past expiry), so a perpetually-rotated handle still terminates
// at the ceiling → re-login. KEY_TTL_SECONDS (24h whk_ key) + GRANT_TTL_SECONDS are the shared issuer SoT.
const REFRESH_TTL_SECONDS = GRANT_TTL_SECONDS;
const DEFAULT_PENDING_INTERVAL = 5;

export interface TokenDeps {
  authCode: AuthCodeDeps;
  refresh: RefreshDeps;
  /** A4b — the device-code grant (poll the DEVICE_KV store, then mint like the auth-code path). */
  device: DeviceTokenDeps;
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

  const refresh: RefreshDeps = {
    allowedAudiences: [API_RESOURCE, MCP_RESOURCE],
    allowedScopes: CAPABILITY_SCOPES,
    keyTtlSeconds: KEY_TTL_SECONDS,

    // Atomic single-use consume + ~90d rotation (the new handle replaces the presented one). Returns the
    // grant's org + audience so the seams below need no cross-org lookup (ADR-0028).
    consumeRefresh: (refreshToken) =>
      consumeRefreshToken(app, refreshToken, hasher, REFRESH_TTL_SECONDS),

    // The grant's consented scope set = the union of its NON-REVOKED child api_keys' scopes (stable: the
    // first key, from the auth-code mint, carries the full consent; refreshes only narrow). token-core
    // intersects requested ∩ this ∩ capability, so a refresh re-widens up to — never beyond — the original
    // consent. Revoked keys are excluded so a future per-key revocation withdraws that scope from refreshes;
    // EXPIRED keys are kept (the full-consent first key expires at the 24h key TTL — dropping it would lose
    // the consent ceiling). Grant-level revoke is gated upstream (consumeRefresh requires an active grant).
    listGrantScopes: async (grantId, orgId) => {
      const keys = await listApiKeysForGrant(app, orgId, grantId);
      return [...new Set(keys.filter((k) => k.revokedAt === null).flatMap((k) => k.scopes))];
    },

    // Re-mint on the grant (writes its own key_minted audit). The grant's status+expiry gate lives in
    // consumeRefresh; mintKeyForGrant additionally serializes against concurrent revokes (SELECT…FOR UPDATE).
    mintKeyForGrant: (input) => mintKeyForGrant(app, input, hasher, auditKey),

    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };

  // A4b — the device-code grant. The provider has no device grant, so this mints directly (like refresh):
  // poll the DEVICE_KV store (single-use delete-on-read), then mintScopedKey (authMethod "device_code") +
  // a refresh handle on the same webhook_app pool. Tenancy is enforced at approval (A4c's getConsentOrg),
  // so this path needs no membership re-check — only the audience/scope defense-in-depth in the core.
  const deviceStore = makeDeviceStoreDeps(env.DEVICE_KV);
  const device: DeviceTokenDeps = {
    allowedAudiences: [API_RESOURCE, MCP_RESOURCE],
    allowedScopes: CAPABILITY_SCOPES,
    keyTtlSeconds: KEY_TTL_SECONDS,
    defaultPendingInterval: DEFAULT_PENDING_INTERVAL,
    poll: (deviceCode) => pollDeviceCode(deviceStore, deviceCode),
    mintScopedKey: (input) =>
      mintScopedKey(
        app,
        { ...input, authMethod: "device_code", grantTtlSeconds: GRANT_TTL_SECONDS },
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
    rollbackMint: async (grantId, orgId) => {
      await revokeGrant(app, { orgId, grantId, reason: "issuance_rollback" }, auditKey);
    },
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };

  return { authCode, refresh, device, close: () => app.end() };
}
