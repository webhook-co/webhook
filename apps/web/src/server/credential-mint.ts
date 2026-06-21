import "server-only";

import { createApiKeyWithAudit, type CreatedApiKey } from "@webhook-co/db/api-keys";
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
 * Mint a standalone api key AND its `key_minted` audit row atomically (Lane B's createApiKeyWithAudit)
 * over the per-request `webhook_app` tenant pool, then release the pool. The hasher is keyed by the
 * shared CREDENTIAL_PEPPER and the audit row is signed with the shared AUDIT_CHAIN_HMAC_KEY (byte-
 * identical to every other surface). The plaintext is returned ONCE — never persisted or logged here.
 * Mocked in the action's unit tests; the real DB path is covered by the db package's integration test.
 */
export async function mintApiKey(input: MintApiKeyInput): Promise<CreatedApiKey> {
  const app = await getTenantDb();
  try {
    const hasher = createCredentialHasherFromBase64(await getCredentialPepper());
    const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    return await createApiKeyWithAudit(
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
