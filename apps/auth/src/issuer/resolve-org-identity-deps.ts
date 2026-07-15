// The auth-side of the mcp→auth org-identity RPC. mcp's `whoami` tool wants the bound org's {id,slug,name}
// to display which org a credential acts in, but keeping DB access off the MCP worker (exactly like
// resolve-profile-deps) means the read runs HERE, over auth.'s tenant Hyperdrive, and mcp only RPCs for it.
// worker.ts's IssuerIntrospect.resolveOrgIdentity delegates here (worker.ts is tsc-excluded; this is the
// type-checked + tested unit).
//
// The org SELF-AUTHORIZES by id: `readOrgIdentity` runs under `withTenant(orgId)`, and `orgs` is FORCE-RLS
// gated on `id = current_org_id()`, so this reads exactly the one org named. `orgId` is NOT the authorization
// boundary the way a secret is — it must come from the caller's OWN introspected principal (the mcp tool
// passes `ctx.orgId`), which is how every other IssuerIntrospect method is scoped. Non-PII, so — unlike
// resolveProfile — there is no scope gate; the value is the org's public URL handle + display name.

import { createClient, readOrgIdentity } from "@webhook-co/db";

import type { OrgIdentity } from "@webhook-co/contract";

/** The minimal env the org-identity RPC needs: the tenant Hyperdrive (RLS-scoped). */
export interface ResolveOrgIdentityEnv {
  readonly HYPERDRIVE_TENANT: { readonly connectionString: string };
}

/** The bound org's {id,slug,name}, or null if the id names no org. Short-lived pool, closed in finally. */
export async function resolveOrgIdentityRpc(
  env: ResolveOrgIdentityEnv,
  orgId: string,
): Promise<OrgIdentity | null> {
  // Fail closed: an empty/absent orgId is never a legitimate lookup — never open a pool.
  if (!orgId) return null;
  const tenant = createClient(env.HYPERDRIVE_TENANT.connectionString, { max: 1 });
  try {
    return await readOrgIdentity(tenant, orgId);
  } finally {
    await tenant.end();
  }
}
