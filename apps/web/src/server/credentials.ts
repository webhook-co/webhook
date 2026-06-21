import "server-only";

import { listApiKeysForGrant, listStandaloneApiKeys } from "@webhook-co/db/api-keys";
import type { Sql } from "@webhook-co/db/client";
import { listGrants } from "@webhook-co/db/grants";

import { getTenantDb } from "./db";

// The credential display shapes. They mirror Lane B's list DTOs (ApiKeyListItem / GrantListItem) — NEITHER
// carries key_hash or plaintext; `start` is the safe redacted prefix. E8b reads them live via Lane B's db
// functions under withTenant(orgId) as webhook_app; RLS (the session orgId) is the tenant backstop.

export type GrantStatus = "pending_approval" | "active" | "revoked" | "expired";
export type AuthMethod = "pkce_loopback" | "device_code";

export interface ApiKeyItem {
  readonly id: string;
  readonly name: string;
  /** The redacted key prefix (e.g. "whsec_3f9a…") — safe to display; never the hash or plaintext. */
  readonly start: string;
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface DeviceGrant {
  readonly id: string;
  readonly status: GrantStatus;
  readonly authMethod: AuthMethod;
  readonly deviceName: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  /** Keys minted under this grant (listApiKeysForGrant) — a grant-revoke cascades to these. */
  readonly keys: readonly ApiKeyItem[];
}

export type CredentialsResult =
  | {
      readonly status: "ok";
      readonly devices: readonly DeviceGrant[];
      readonly keys: readonly ApiKeyItem[];
    }
  | { readonly status: "error" }
  | { readonly status: "denied" };

/**
 * The org's grants + keys, read live. Injected for tests; the default binds Lane B's list functions to the
 * per-request tenant client. Lane B's `GrantListItem`/`ApiKeyListItem` are structurally these display types.
 */
export interface CredentialReaders {
  listGrants(orgId: string): Promise<readonly Omit<DeviceGrant, "keys">[]>;
  listApiKeysForGrant(orgId: string, grantId: string): Promise<readonly ApiKeyItem[]>;
  /** STANDALONE keys only (grant_id IS NULL) — grant-backed keys show under their device, not here. */
  listStandaloneApiKeys(orgId: string): Promise<readonly ApiKeyItem[]>;
}

function boundReaders(app: Sql): CredentialReaders {
  return {
    listGrants: (orgId) => listGrants(app, orgId),
    listApiKeysForGrant: (orgId, grantId) => listApiKeysForGrant(app, orgId, grantId),
    listStandaloneApiKeys: (orgId) => listStandaloneApiKeys(app, orgId),
  };
}

async function readCredentials(orgId: string, r: CredentialReaders): Promise<CredentialsResult> {
  try {
    const [grants, keys] = await Promise.all([r.listGrants(orgId), r.listStandaloneApiKeys(orgId)]);
    const devices = await Promise.all(
      grants.map(async (grant) => ({
        ...grant,
        keys: await r.listApiKeysForGrant(orgId, grant.id),
      })),
    );
    return { status: "ok", devices, keys };
  } catch {
    return { status: "error" };
  }
}

/**
 * Load the org's credentials for the dashboard. Reads grants + their child keys + STANDALONE keys via
 * Lane B; a db/Hyperdrive fault surfaces as `{ status: "error" }` (the view shows the error state) rather
 * than throwing. Never returns hash/plaintext. Owns the per-request DB pool and releases it (mirrors
 * apps/api's teardown) so connections don't leak. Tests inject `readers` and skip the pool entirely.
 */
export async function loadCredentials(
  orgId: string,
  readers?: CredentialReaders,
): Promise<CredentialsResult> {
  if (readers) return readCredentials(orgId, readers);
  const app = await getTenantDb();
  try {
    return await readCredentials(orgId, boundReaders(app));
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
  }
}
