import { z } from "zod";

// Cross-surface enums. The dedup/scheme/provider/status vocabularies are frozen here
// so CLI/API/web/MCP (and the DB repositories) share one definition.

/**
 * How `events.dedup_key` was derived, recorded so inspection can explain why
 * two events did or didn't collapse. First match wins, in this order.
 */
export const DEDUP_STRATEGIES = ["sw_webhook_id", "provider_event_id", "content_hash"] as const;
export const DedupStrategySchema = z.enum(DEDUP_STRATEGIES);
export type DedupStrategy = z.infer<typeof DedupStrategySchema>;

/** Recognized inbound providers (best-effort detection; never blocks ingest). */
export const PROVIDERS = ["stripe", "github", "shopify", "slack", "standard_webhooks"] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof ProviderSchema>;

/** Lifecycle of an envelope-encrypted key (signing_keys / provider_secrets). */
export const KEY_STATUSES = ["active", "retiring", "revoked"] as const;
export const KeyStatusSchema = z.enum(KEY_STATUSES);
export type KeyStatus = z.infer<typeof KeyStatusSchema>;

/** Org membership roles (drives RBAC). */
export const MEMBERSHIP_ROLES = ["owner", "admin", "member"] as const;
export const MembershipRoleSchema = z.enum(MEMBERSHIP_ROLES);
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;

/** Soft-cap pause policy (org_limits). No prices/tiers — just the behavior. */
export const PAUSE_POLICIES = ["pause", "allow"] as const;
export const PausePolicySchema = z.enum(PAUSE_POLICIES);
export type PausePolicy = z.infer<typeof PausePolicySchema>;
