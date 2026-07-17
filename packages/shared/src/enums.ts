import { z } from "zod";

// Cross-surface enums. The dedup/scheme/provider/status vocabularies are frozen here
// so CLI/API/web/MCP (and the DB repositories) share one definition.

/**
 * How `events.dedup_key` was derived, recorded so inspection can explain why
 * two events did or didn't collapse. First match wins, in this order.
 */
export const DEDUP_STRATEGIES = [
  "sw_webhook_id",
  "provider_event_id",
  "content_hash",
  // `fields` — key derived from an endpoint's configured field selectors (fields mode).
  "fields",
  // `unique` — a per-request unique key (off mode, or the fail-safe when a configured field is
  // unresolvable): every request is a distinct event, nothing ever collapses.
  "unique",
] as const;
export const DedupStrategySchema = z.enum(DEDUP_STRATEGIES);
export type DedupStrategy = z.infer<typeof DedupStrategySchema>;

/**
 * The HTTP methods offered as an events FILTER vocabulary (the seven standard verbs).
 *
 * Ingestion accepts ALL verbs and stores the raw captured method, so `events.method` can in principle hold
 * a non-standard verb; this closed set is the filter/facet vocabulary, not a constraint on what was stored.
 * A NULL method (legacy pre-0028 rows) matches no value — an `IN (...)` filter never selects NULL.
 */
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export const HttpMethodSchema = z.enum(HTTP_METHODS);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

// PROVIDERS / ProviderSchema / Provider are defined in @webhook-co/webhooks-spec (the leaf
// package that owns the provider vocabulary + verification adapters) and re-exported by this
// package's index, so there is still one cross-surface import site (`@webhook-co/shared`).

/** Lifecycle of an envelope-encrypted key (signing_keys / provider_secrets). */
export const KEY_STATUSES = ["active", "retiring", "revoked"] as const;
export const KeyStatusSchema = z.enum(KEY_STATUSES);
export type KeyStatus = z.infer<typeof KeyStatusSchema>;

/** Org membership roles (drives RBAC). Ordered MOST → least privileged; the index is the rank. */
export const MEMBERSHIP_ROLES = ["owner", "admin", "member"] as const;
export const MembershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;

/** Privilege rank of a role: 0 = owner (most), higher = less. Unknown → Infinity (least, fails safe). */
export function roleRank(role: string): number {
  const i = (MEMBERSHIP_ROLES as readonly string[]).indexOf(role);
  return i === -1 ? Number.POSITIVE_INFINITY : i;
}

/**
 * May `actorRole` grant/assign `targetRole`? Yes iff the target is at or below the actor's own privilege —
 * an admin can invite/promote to admin or member, never to owner; a member can grant nothing above member.
 * The invariant behind invites and role changes: you cannot hand out more than you hold. Unknown roles fail
 * closed (an unknown actor grants nothing; an unknown target is never grantable).
 */
export function canGrantRole(actorRole: string, targetRole: string): boolean {
  const a = roleRank(actorRole);
  const t = roleRank(targetRole);
  return Number.isFinite(a) && Number.isFinite(t) && t >= a;
}

/** Soft-cap pause policy (org_limits). No prices/tiers — just the behavior. */
export const PAUSE_POLICIES = ["pause", "allow"] as const;
export const PausePolicySchema = z.enum(PAUSE_POLICIES);
export type PausePolicy = z.infer<typeof PausePolicySchema>;
