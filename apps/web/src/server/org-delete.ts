import type { Sql } from "@webhook-co/db/client";
import { deleteOrgWithAudit, requestOrgDeletion } from "@webhook-co/db/org-lifecycle";
import type { AuditActorInput } from "@webhook-co/shared";

import { evictRevokedKeyHashes } from "./credential-revoke";
import { getAsyncOrgDeletionEnabled } from "./env";

/**
 * Delete an org, routing through the async or synchronous path per the ASYNC_ORG_DELETION flag (#665).
 *
 * Shared by both delete surfaces — the single-org `deleteOrganization` and the `deleteAccount` loop over a
 * user's solo-owned orgs — so the flag-gate and the credential-cache eviction live in exactly one place.
 *
 * When async is enabled, `requestOrgDeletion` marks the org `deleting` (the reaper drains its rows) and
 * revokes its credentials in the DB, returning the revoked key hashes; we MUST then evict those from KV_AUTHZ
 * — the DB revoke stamp alone only lapses within the credential-cache TTL, so an un-evicted revoked key would
 * keep authenticating against the still-existing org for the whole reaper window. Best-effort (same contract
 * as removeMemberAction): the DB stamp is durable, so an eviction fault is logged + swallowed. When async is
 * off (the fail-safe default until the reaper is provisioned), it is the proven synchronous hard-delete.
 */
export async function deleteOrRequestOrg(
  app: Sql,
  input: { orgId: string; actor: AuditActorInput },
  auditKey: CryptoKey,
): Promise<void> {
  if (!getAsyncOrgDeletionEnabled()) {
    await deleteOrgWithAudit(app, input, auditKey);
    return;
  }
  const { revokedKeyHashes } = await requestOrgDeletion(app, input, auditKey);
  await evictRevokedKeyHashes(revokedKeyHashes, { kind: "org", id: input.orgId });
}
