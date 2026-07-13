import "server-only";

import { listApiKeysForGrants, listStandaloneApiKeys } from "@webhook-co/db/api-keys";
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
  // Reserved for a future role-aware load — a member viewing an org they may read but not manage. No
  // current code path returns it (the v1 dashboard is a single personal org); the read-only "denied"
  // view + its tests are kept so the affordance is ready when membership roles land.
  | { readonly status: "denied" };

/**
 * The org's grants + keys, read live. Injected for tests; the default binds Lane B's list functions to the
 * per-request tenant client. Lane B's `GrantListItem`/`ApiKeyListItem` are structurally these display types.
 */
export interface CredentialReaders {
  listGrants(orgId: string): Promise<readonly Omit<DeviceGrant, "keys">[]>;
  /**
   * The keys for ALL the org's grants, in one read, keyed by grant id.
   *
   * This replaced a per-grant `listApiKeysForGrant`, which was an N+1 whose `Promise.all` was a fiction: each
   * call opened its own transaction, and they all queued on the same connection, so they ran strictly
   * serially. The page cost grew with every device the user had ever authorised.
   */
  listApiKeysForGrants(
    orgId: string,
    grantIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ApiKeyItem[]>>;
  /** STANDALONE keys only (grant_id IS NULL) — grant-backed keys show under their device, not here. */
  listStandaloneApiKeys(orgId: string): Promise<readonly ApiKeyItem[]>;
}

function boundReaders(app: Sql): CredentialReaders {
  return {
    listGrants: (orgId) => listGrants(app, orgId),
    listApiKeysForGrants: (orgId, grantIds) => listApiKeysForGrants(app, orgId, grantIds),
    listStandaloneApiKeys: (orgId) => listStandaloneApiKeys(app, orgId),
  };
}

async function readCredentials(orgId: string, r: CredentialReaders): Promise<CredentialsResult> {
  try {
    const [grants, keys] = await Promise.all([r.listGrants(orgId), r.listStandaloneApiKeys(orgId)]);
    // ONE read for every grant's keys, not one per grant. `listApiKeysForGrants` returns a bucket for every
    // id asked for, so a device with no keys is present-and-empty rather than missing.
    const keysByGrant = await r.listApiKeysForGrants(
      orgId,
      grants.map((g) => g.id),
    );
    const devices = grants.map((grant) => ({ ...grant, keys: keysByGrant.get(grant.id) ?? [] }));
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
  // The REQUEST owns the client now (see server/db.ts): it is shared by every loader in this render and
  // closed once, after the response. Closing it here would pull the connection out from under the others.
  return readCredentials(orgId, boundReaders(await getTenantDb()));
}
