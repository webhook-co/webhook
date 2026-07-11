import { isBillingManagerRole, type MembershipRole } from "@webhook-co/shared";

import { CAPABILITY_SCOPES, type CapabilityScope } from "./capability";

// The mint ceiling: a key may never grant more than the human who created it.
//
// Scopes and membership roles were, until now, two unrelated vocabularies. `createApiKey` narrowed a
// requested scope set to the full CAPABILITY_SCOPES and nothing else — so ANY member could mint a key with
// ANY scope. Harmless while every org has exactly one owner; a privilege escalation the moment a second
// member exists, in two concrete ways:
//
//   * `billing:read` — a member is refused by the billing page (owner/admin only, enforced server-side),
//     then mints themselves a billing key and reads the same data over the API. The gate becomes decorative.
//   * `audit:read`   — a member reads the org's tamper-evident compliance chain, which is an admin concern.
//
// And keys are DURABLE: `expires_at` may be null, and a key minted under permissive rules keeps working
// long after the rules tighten. So the ceiling must exist BEFORE a second member does — this cannot be
// retrofitted onto credentials that already exist.
//
// The rule is deliberately the smallest one that is true: `member` is the floor and legitimately holds
// write, so its ceiling is "everything operational". The ceiling only withholds the two scopes that encode
// an owner/admin-only capability. It is enforced at the DB mint chokepoint (`insertApiKey`) — every key in
// the system is born there, including the OAuth and device-code paths — so a new mint path cannot be added
// without declaring whose authority it mints under.

/** Scopes that encode an owner/admin-only capability, so a plain `member` must not be able to grant them. */
const MANAGER_ONLY_SCOPES: readonly CapabilityScope[] = [
  // The billing gate (isBillingManagerRole) is owner/admin. A member who could mint this would simply read
  // billing over the API instead.
  "billing:read",
  // The audit chain is the org's compliance record. Reading it is an administrative act.
  "audit:read",
];

/**
 * The scopes `role` is permitted to grant to a key it creates. Fails CLOSED: an absent membership, or a role
 * this file doesn't know about, mints NOTHING — so a future role added by migration is powerless until
 * someone deliberately grants it power here, rather than silently inheriting everything.
 */
export function mintableScopes(
  role: MembershipRole | null | undefined,
): readonly CapabilityScope[] {
  if (role === "owner" || role === "admin") return CAPABILITY_SCOPES;
  if (role === "member") {
    return CAPABILITY_SCOPES.filter((s) => !MANAGER_ONLY_SCOPES.includes(s));
  }
  return [];
}

/**
 * The scopes in `requested` that `role` may NOT grant — empty when the request is within the ceiling.
 *
 * Returns the offending scopes rather than a boolean so the caller can name them: silently minting a WEAKER
 * key than asked for is a bad surprise (the user believes they hold a scope they don't, and finds out at
 * some later 403), and silently minting a STRONGER one is the bug this exists to prevent. Anything outside
 * the closed capability set (e.g. the reserved `keys:manage`) is over the ceiling for every role.
 */
export function exceedsMintCeiling(
  role: MembershipRole | null | undefined,
  requested: readonly string[],
): readonly string[] {
  const allowed = new Set<string>(mintableScopes(role));
  return requested.filter((s) => !allowed.has(s));
}

/** Re-exported so the mint chokepoint can name the billing rule it defers to without a second import. */
export { isBillingManagerRole };
