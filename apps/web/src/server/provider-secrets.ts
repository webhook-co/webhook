import "server-only";

import { type Sql } from "@webhook-co/db/client";
import {
  listEndpointProviderSecrets,
  type ProviderSecretMetadata,
} from "@webhook-co/db/provider-secrets";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";

// The provider-secret read surface for the endpoint detail page (listProviderSecrets). A provider secret is
// the inbound-VERIFICATION material for an endpoint; it is WRITE-ONLY, so this read returns METADATA ONLY
// (id/provider/status/label/createdAt) — the db function SELECTs no ciphertext / wrapped-DEK / nonce columns,
// so the sealed bytes and the plaintext never leave the DB through it. Read live via the Lane fn under
// withTenant(orgId) as webhook_app; RLS (the session orgId) is the tenant backstop, so a cross-org endpoint
// simply yields an empty list. Mirrors replay-destinations' loader shape.

/** A provider-secret row for the dashboard — non-secret metadata only. */
export type ProviderSecretItem = ProviderSecretMetadata;

export type ProviderSecretsResult =
  | { readonly status: "ok"; readonly items: readonly ProviderSecretItem[] }
  | { readonly status: "error" };

/** The read this surface needs, injectable for tests; the default binds the per-request tenant pool. */
export interface ProviderSecretReaders {
  list(orgId: string, endpointId: string): Promise<ProviderSecretMetadata[]>;
}

function boundReaders(app: Sql): ProviderSecretReaders {
  return {
    list: (orgId, endpointId) => listEndpointProviderSecrets(app, orgId, endpointId),
  };
}

/**
 * Load an endpoint's provider secrets as metadata only (newest-first, whole set — intentionally
 * un-paginated). A db fault reads as `{status:"error"}` (logged, scrubbed). A missing / cross-org endpoint
 * simply yields an empty list under RLS (no existence oracle). Tests inject `readers` and skip the pool.
 */
export async function loadProviderSecrets(
  orgId: string,
  endpointId: string,
  readers?: ProviderSecretReaders,
): Promise<ProviderSecretsResult> {
  const load = (r: ProviderSecretReaders) =>
    r.list(orgId, endpointId).then((items) => ({ status: "ok" as const, items }));
  try {
    if (readers) return await load(readers);
    return await withTenantDb((app) => load(boundReaders(app)));
  } catch (error) {
    logActionError("provider_secrets.load", error);
    return { status: "error" };
  }
}
