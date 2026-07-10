// Slice 2.2 account erasure — the auth-side of the web→auth account-delete RPC. Only apps/auth
// (webhook_auth via HYPERDRIVE_AUTH) may touch the global identity realm (user/session/account), so
// apps/web RPCs the AccountDeleter WorkerEntrypoint (worker.ts) which delegates here. Kept as a thin,
// type-checked module (worker.ts itself is tsc-excluded), mirroring session-exchange-deps.
//
// AUTHZ: the caller (apps/web) has already verified the session and passes ITS OWN authenticated
// userId — the binding is worker-to-worker (not public), so a user can only ever erase themselves.
// Orgs the user solely owns are deleted by the web caller FIRST (deleteOrgWithAudit); this removes
// the identity only (cascades sessions/accounts/memberships; the auth_grant approver/revoker
// references are nulled by migration 0052).

import { createClient, deleteUserIdentity } from "@webhook-co/db";

/** The minimal env the account-delete RPC needs: the webhook_auth Hyperdrive over the identity realm. */
export interface AccountDeleteEnv {
  readonly HYPERDRIVE_AUTH: { readonly connectionString: string };
}

export interface AccountDeleteResult {
  /** True if a user row was removed (false if it was already gone — idempotent). */
  readonly deleted: boolean;
}

/** Erase a user's identity as webhook_auth. Short-lived pool, closed in finally. */
export async function deleteAccountRpc(
  env: AccountDeleteEnv,
  userId: string,
): Promise<AccountDeleteResult> {
  const authClient = createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 1 });
  try {
    return { deleted: await deleteUserIdentity(authClient, userId) };
  } finally {
    await authClient.end();
  }
}
