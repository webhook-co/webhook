import "server-only";

import { createApiKeyWithAudit, type CreatedApiKey } from "@webhook-co/db/api-keys";
import type { Sql } from "@webhook-co/db/client";
import { createCredentialHasherFromBase64 } from "@webhook-co/db/credential";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";

import { getTenantDb } from "./db";
import { getAuditChainKey, getCredentialPepper } from "./env";

export interface MintApiKeyInput {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly scopes: readonly string[];
}

/**
 * The injectable boundaries of {@link mintApiKey}: the per-request DB pool, the two secrets, and the DB
 * write. The pure transforms (hasher + audit key from base64) are deliberately NOT injected, so a unit
 * test still exercises the real imports — the surface that once bundled to `undefined`. Defaults bind the
 * live env + Lane B.
 */
export interface MintApiKeyDeps {
  getDb: () => Promise<Sql>;
  getPepper: () => Promise<string>;
  getAuditChainKey: () => Promise<string>;
  createKey: typeof createApiKeyWithAudit;
}

const defaultDeps: MintApiKeyDeps = {
  getDb: getTenantDb,
  getPepper: getCredentialPepper,
  getAuditChainKey,
  createKey: createApiKeyWithAudit,
};

/**
 * Mint a standalone api key AND its `key_minted` audit row atomically (Lane B's createApiKeyWithAudit)
 * over the per-request `webhook_app` tenant pool, then release the pool. The hasher is keyed by the
 * shared CREDENTIAL_PEPPER and the audit row is signed with the shared AUDIT_CHAIN_HMAC_KEY (byte-
 * identical to every other surface). The plaintext is returned ONCE — never persisted or logged here.
 * Boundaries are injectable for the glue unit test; the real DB path is covered by the db package.
 */
export async function mintApiKey(
  input: MintApiKeyInput,
  deps: MintApiKeyDeps = defaultDeps,
): Promise<CreatedApiKey> {
  const app = await deps.getDb();
  try {
    const hasher = createCredentialHasherFromBase64(await deps.getPepper());
    const auditKey = await importAuditKey(b64ToBytes(await deps.getAuditChainKey()));
    return await deps.createKey(
      app,
      { orgId: input.orgId, name: input.name, scopes: input.scopes },
      hasher,
      auditKey,
      input.userId,
    );
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
  }
}
