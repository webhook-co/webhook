// The auth-side of the mcp→auth profile-resolution RPC. Only apps/auth (webhook_auth via HYPERDRIVE_AUTH)
// may read the global identity realm (the better-auth `user` table), so mcp's `whoami` tool RPCs the
// IssuerIntrospect.resolveProfile method (worker.ts) which delegates here. Thin, type-checked (worker.ts
// itself is tsc-excluded), mirroring account-delete-deps.
//
// This is deliberately SEPARATE from token introspection: introspection stays pseudonymous + hot-path-fast
// (scopes + userId only), and name/email are fetched ON DEMAND — only when the whoami tool runs and only
// when the token carries the consented `profile` scope. The mcp tool passes the userId it got from its own
// introspected principal, so a client can only resolve the profile of the user whose token it holds.

import { createClient, getAuthUserProfile } from "@webhook-co/db";

import type { UserProfile } from "@webhook-co/contract";

/** The minimal env the profile RPC needs: the webhook_auth Hyperdrive over the identity realm. */
export interface ResolveProfileEnv {
  readonly HYPERDRIVE_AUTH: { readonly connectionString: string };
}

/** Resolve a user's name + email as webhook_auth, or null if no such user. Short-lived pool, closed in finally. */
export async function resolveProfileRpc(
  env: ResolveProfileEnv,
  userId: string,
): Promise<UserProfile | null> {
  const authClient = createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 1 });
  try {
    const profile = await getAuthUserProfile(authClient, userId);
    return profile ? { name: profile.name, email: profile.email } : null;
  } finally {
    await authClient.end();
  }
}
