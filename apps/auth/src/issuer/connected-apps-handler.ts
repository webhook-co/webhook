// Wires the connected-apps core to the provider's getOAuthApi() grant helpers (listUserGrants / lookupClient
// / revokeGrant), which read THIS Worker's OAUTH_KV grant store. Imported ONLY by src/worker.ts's
// ConnectedApps WorkerEntrypoint (the wrangler layer), never by `next build` — so the getOAuthApi import
// (which eagerly pulls cloudflare:workers) is fine. Type-checked; the thin entrypoint wrapper is the only
// untyped piece (worker.ts is tsc-excluded).

import { getOAuthApi } from "@cloudflare/workers-oauth-provider";

import { listConnectedApps, type RawGrant } from "./connected-apps-core";
import { HELPERS_DEFAULT_HANDLER } from "./issuer-constants";
import { oauthIssuerConfig } from "./oauth-config";

import type { ConnectedApp } from "@webhook-co/contract";
import type { IntrospectEnv } from "../runtime/env";

/** The subset of the provider's OAuthHelpers this handler uses (typed locally — the .d.ts isn't re-exported). */
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
    }[];
    cursor?: string;
  }>;
  lookupClient: (clientId: string) => Promise<{ clientName?: string } | null>;
  revokeGrant: (grantId: string, userId: string) => Promise<void>;
}

function helpers(env: IntrospectEnv): GrantHelpers {
  return getOAuthApi(
    { ...oauthIssuerConfig, defaultHandler: HELPERS_DEFAULT_HANDLER },
    env as never,
  ) as unknown as GrantHelpers;
}

/** List a user's active connected apps (their authorized OAuth clients) from the provider grant store. */
export async function listUserConnectedApps(
  env: IntrospectEnv,
  userId: string,
): Promise<ConnectedApp[]> {
  const api = helpers(env);
  return listConnectedApps(
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
            });
          }
          cursor = page.cursor;
        } while (cursor);
        return out;
      },
      lookupClientName: async (clientId) => (await api.lookupClient(clientId))?.clientName ?? null,
    },
    userId,
  );
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
