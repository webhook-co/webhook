// The pure core of the MCP `whoami` tool: given the caller's authenticated principal, return who they are.
// orgId + userId (if any) + scopes are ALWAYS returned (they're non-PII and identify the credential). The
// user's name + email are returned ONLY when the token carries the consented `profile` scope AND a userId is
// present — resolved on-demand via the injected auth RPC, so PII stays off the hot introspection path and is
// exposed to a third-party client only when the user explicitly consented to `profile`.
//
// I/O-free (the profile resolver is injected), so the scope-gate + fallback are unit-tested. A resolver
// fault degrades to the base identity rather than failing the whole tool.

import { PROFILE_SCOPE, type AuthContext, type UserProfile } from "@webhook-co/contract";

export interface WhoamiResult {
  orgId: string;
  userId?: string;
  scopes: readonly string[];
  name?: string;
  email?: string;
}

export async function buildWhoami(
  ctx: AuthContext,
  resolveProfile: (userId: string) => Promise<UserProfile | null>,
): Promise<WhoamiResult> {
  const base: WhoamiResult = {
    orgId: ctx.orgId,
    scopes: ctx.scopes,
    ...(ctx.userId ? { userId: ctx.userId } : {}),
  };
  // Gate: identity is exposed only to a user-bound principal that consented to `profile`.
  if (!ctx.userId || !ctx.scopes.includes(PROFILE_SCOPE)) return base;
  try {
    const profile = await resolveProfile(ctx.userId);
    return profile ? { ...base, name: profile.name, email: profile.email } : base;
  } catch {
    // A profile-RPC fault must not fail whoami — return the base identity.
    return base;
  }
}
