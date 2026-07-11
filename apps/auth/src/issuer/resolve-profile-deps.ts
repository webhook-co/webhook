// The auth-side of the mcp→auth profile-resolution RPC. Only apps/auth (webhook_auth via HYPERDRIVE_AUTH)
// may read the global identity realm (the better-auth `user` table), so mcp's `whoami` tool RPCs the
// IssuerIntrospect.resolveProfile method (worker.ts) which delegates here. Thin, type-checked (worker.ts
// itself is tsc-excluded), mirroring account-delete-deps.
//
// This is deliberately SEPARATE from token introspection: introspection stays pseudonymous + hot-path-fast
// (scopes + userId only), and name/email are fetched ON DEMAND — only when the whoami tool runs and only
// when the token carries the consented `profile` scope. The mcp tool passes the userId it got from its own
// introspected principal, so a client can only resolve the profile of the user whose token it holds.
//
// TRUST CONTRACT (defense-in-depth): this is a raw PII-read primitive keyed by userId, with the SAME
// trusted-first-party-service-binding model as IssuerIntrospect.introspect / AccountDeleter / SessionExchange
// — it is reachable ONLY over the AUTH_ISSUER binding (no fetch handler, no public route), and it performs no
// scope check of its own. The `profile`-consent gate is enforced one layer out, by the resource server
// (apps/mcp `buildWhoami`) on the PROVIDER-VALIDATED principal it obtained by unwrapping the bearer at the
// edge. We do NOT re-introspect a token here on purpose: the token is consumed at the mcp edge and never
// forwarded into the Durable Object's persisted props, so passing it inward would mean retaining a live
// bearer at rest — a strictly worse posture. Any FUTURE worker granted this binding MUST likewise pass only
// its own validated principal's userId. As a floor, we fail closed on an empty/absent userId below.

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
  // Fail closed: an empty/absent userId is never a legitimate lookup — never open a pool or hit the realm.
  if (!userId) return null;
  const authClient = createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 1 });
  try {
    const profile = await getAuthUserProfile(authClient, userId);
    return profile ? { name: profile.name, email: profile.email } : null;
  } finally {
    await authClient.end();
  }
}
