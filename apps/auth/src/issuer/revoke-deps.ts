// A2b-4b — wires the /revoke core to the real DB resolution + grant cascade + KV_AUTHZ eviction. I/O glue
// (not unit-tested; typecheck- + build:cf-/deploy:dry-verified). Two pools: webhook_authn resolves a whk_
// access key to its grant cross-org by hash (findApiKeyGrant); webhook_app resolves an rtk_ refresh handle
// (org embedded), runs the grant cascade, and revokes the grant's refresh handles. KV_AUTHZ is evicted by
// the exact key the resolver writes (credentialCacheKey = hex of the hash).

import {
  createClient,
  createCredentialHasherFromBase64,
  credentialCacheKey,
  findApiKeyGrant,
  findRefreshTokenGrant,
  revokeGrant,
  revokeRefreshTokensForGrant,
} from "@webhook-co/db";
import { b64ToBytes, importAuditKey, readSecretBinding } from "@webhook-co/shared";

import type { RevokeDeps } from "./revoke-route";
import type { RevokeEnv } from "../runtime/env";

/** The slice of KV we use for principal-cache eviction (structural — avoids a Workers-global lib dep). */
interface CacheEvicter {
  delete(key: string): Promise<void>;
}

export interface RevokeRuntime {
  deps: RevokeDeps;
  /** Drain the per-request pools (call via ctx.waitUntil after the response). */
  close: () => Promise<void>;
}

export async function makeRevokeDeps(env: RevokeEnv): Promise<RevokeRuntime> {
  const [pepper, auditRaw] = await Promise.all([
    readSecretBinding(env.CREDENTIAL_PEPPER),
    readSecretBinding(env.AUDIT_CHAIN_HMAC_KEY),
  ]);
  const hasher = createCredentialHasherFromBase64(pepper);
  const auditKey = await importAuditKey(b64ToBytes(auditRaw));
  const cache = env.KV_AUTHZ as CacheEvicter;
  const authn = createClient(env.HYPERDRIVE_AUTHN.connectionString, { max: 2 });
  const app = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 2 });

  const deps: RevokeDeps = {
    resolveAccessTokenGrant: (token) => findApiKeyGrant(authn, token, hasher),
    resolveRefreshTokenGrant: (token) => findRefreshTokenGrant(app, token, hasher),
    revokeGrantAndEvict: async (orgId, grantId) => {
      const { revokedKeyHashes } = await revokeGrant(
        app,
        { orgId, grantId, reason: "cli_logout" },
        auditKey,
      );
      // Also kill the grant's refresh handles (defense-in-depth — the consume gate already blocks a revoked
      // grant from refreshing). DB commit is authoritative; KV eviction is best-effort (a miss self-heals
      // at the cache TTL), so a KV error never fails the revoke.
      await revokeRefreshTokensForGrant(app, { orgId, grantId });
      await Promise.all(
        revokedKeyHashes.map((keyHash) =>
          cache
            .delete(credentialCacheKey(keyHash))
            .catch((error: unknown) =>
              console.log(
                JSON.stringify({ message: "revoke.kv_evict_failed", error: String(error) }),
              ),
            ),
        ),
      );
    },
    log: (event, fields) => console.log(JSON.stringify({ message: event, ...fields })),
  };

  return {
    deps,
    close: async () => {
      await Promise.allSettled([app.end(), authn.end()]);
    },
  };
}
