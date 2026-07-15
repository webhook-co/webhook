// Wires the connected-apps core to the provider's getOAuthApi() grant helpers (listUserGrants / lookupClient
// / revokeGrant), which read THIS Worker's OAUTH_KV grant store. Imported ONLY by src/worker.ts's
// ConnectedApps WorkerEntrypoint (the wrangler layer), never by `next build` — so the getOAuthApi import
// (which eagerly pulls cloudflare:workers) is fine. Type-checked; the thin entrypoint wrapper is the only
// untyped piece (worker.ts is tsc-excluded).

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { createClient, readOrgIdentity } from "@webhook-co/db";

import { listConnectedApps, type RawGrant } from "./connected-apps-core";
import { HELPERS_DEFAULT_HANDLER } from "./issuer-constants";
import { oauthIssuerConfig } from "./oauth-config";

import type { ConnectedApp } from "@webhook-co/contract";
import type { ConnectedAppsEnv, IntrospectEnv } from "../runtime/env";

/** The subset of the provider's OAuthHelpers this handler uses — declared locally so the getOAuthApi return
 *  (an `any`-ish cast under our DOM tsconfig) is narrowed to exactly the three methods we call. */
interface GrantHelpers {
  listUserGrants: (
    userId: string,
    options?: { cursor?: string },
  ) => Promise<{
    items: {
      id: string;
      clientId: string;
      scope: string[];
      createdAt: number;
      expiresAt?: number;
      /** Unencrypted grant metadata — carries `{ orgId }` since the org was recorded at consent. */
      metadata?: unknown;
    }[];
    cursor?: string;
  }>;
  lookupClient: (clientId: string) => Promise<{ clientName?: string } | null>;
  revokeGrant: (grantId: string, userId: string) => Promise<void>;
}

/** Pull the bound org id off a grant's unencrypted metadata (`{ orgId }`), tolerating any legacy shape. */
function grantOrgId(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const orgId = (metadata as { orgId?: unknown }).orgId;
  return typeof orgId === "string" && orgId.length > 0 ? orgId : undefined;
}

function helpers(env: IntrospectEnv): GrantHelpers {
  return getOAuthApi(
    { ...oauthIssuerConfig, defaultHandler: HELPERS_DEFAULT_HANDLER },
    env as never,
  ) as unknown as GrantHelpers;
}

/** List a user's active connected apps (their authorized OAuth clients) from the provider grant store. */
export async function listUserConnectedApps(
  env: ConnectedAppsEnv,
  userId: string,
): Promise<ConnectedApp[]> {
  const api = helpers(env);
  // A short-lived tenant client for the best-effort org-identity reads (each org self-authorizes by id under
  // RLS; see readOrgIdentity), torn down in finally. If the tenant binding is ever absent, the app LIST still
  // works — the org is simply omitted (no resolver passed) rather than the whole list failing.
  const tenantConn = env.HYPERDRIVE_TENANT?.connectionString;
  const tenant = tenantConn ? createClient(tenantConn, { max: 1 }) : undefined;
  try {
    return await listConnectedApps(
      {
        listUserGrants: async (uid) => {
          // The provider paginates; drain every page so a user with many grants sees them all.
          const out: RawGrant[] = [];
          let cursor: string | undefined;
          do {
            const page = await api.listUserGrants(uid, cursor ? { cursor } : undefined);
            for (const g of page.items) {
              out.push({
                id: g.id,
                clientId: g.clientId,
                scope: g.scope,
                createdAt: g.createdAt,
                expiresAt: g.expiresAt,
                orgId: grantOrgId(g.metadata),
              });
            }
            cursor = page.cursor;
          } while (cursor);
          return out;
        },
        lookupClientName: async (clientId) =>
          (await api.lookupClient(clientId))?.clientName ?? null,
        ...(tenant ? { resolveOrgIdentity: (orgId) => readOrgIdentity(tenant, orgId) } : {}),
      },
      userId,
    );
  } finally {
    if (tenant) await tenant.end();
  }
}

/**
 * Revoke one connected app by grant id. The provider's revokeGrant deletes ONLY `grant:<userId>:<grantId>`,
 * so passing the SERVER-authenticated userId means a user can only ever revoke their own grant — no
 * ownership check needed here (a mismatched userId simply no-ops). Idempotent; returns true.
 */
export async function revokeUserConnectedApp(
  env: IntrospectEnv,
  userId: string,
  grantId: string,
): Promise<boolean> {
  await helpers(env).revokeGrant(grantId, userId);
  return true;
}
