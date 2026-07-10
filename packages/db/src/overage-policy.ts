// The overage opt-in setter (WS3). A paid org toggles whether usage past its included volume is BILLED
// (pause_policy 'allow' = overage on) or the org is PAUSED at the cap and never billed past it
// (pause_policy 'pause' = overage off, the default). The flip is an admin-gated, audited policy change
// (SEC-RLS-08). Enforcement re-evaluation + edge-cache eviction happen in the caller (the web action →
// engine RPC), because the ingest KV cache lives in the engine; this module owns only the DB truth.

import type { PausePolicy } from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";
import type { MembershipRole } from "./orgs";

/** The result of a toggle attempt. `changed` distinguishes a real flip (→ the caller must re-evaluate the
 *  cap + evict) from a no-op set to the current value (→ nothing to do). */
export type SetOverageResult =
  | { readonly status: "ok"; readonly policy: PausePolicy; readonly changed: boolean }
  /** The caller isn't an owner/admin of the org — a policy change is admin-only (SEC-RLS-08). */
  | { readonly status: "forbidden" }
  /** No org_limits row: a Free org has no paid plan to bill overage against, so it can't opt in. */
  | { readonly status: "no_subscription" };

/** Roles allowed to change org billing policy. Plain members cannot (SEC-RLS-08). */
function canChangePolicy(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Flip `org_limits.pause_policy` for `orgId` to reflect `enabled` (true = overage on = 'allow'). Runs the
 * membership-role gate, the update, and the audit append in ONE tenant transaction so an unauthorized
 * caller can never write, and an authorized flip is always accompanied by its audit row (or neither
 * commits). Idempotent: setting the policy to its current value writes nothing and returns `changed:false`.
 *
 * @param auditKey the audit-chain HMAC key (from the runtime binding).
 */
export async function setOverageEnabled(
  app: Sql,
  auditKey: CryptoKey,
  args: { orgId: string; userId: string; enabled: boolean },
): Promise<SetOverageResult> {
  const policy: PausePolicy = args.enabled ? "allow" : "pause";
  return withTenant(app, args.orgId, async (tx): Promise<SetOverageResult> => {
    const [member] = await tx<{ role: MembershipRole }[]>`
      select role from memberships where org_id = ${args.orgId} and user_id = ${args.userId} limit 1`;
    if (!member || !canChangePolicy(member.role)) return { status: "forbidden" };

    const [before] = await tx<{ pause_policy: PausePolicy }[]>`
      select pause_policy from org_limits`;
    if (!before) return { status: "no_subscription" }; // Free org (no paid mirror) can't enable overage

    if (before.pause_policy === policy) return { status: "ok", policy, changed: false };

    await tx`update org_limits set pause_policy = ${policy}`;
    await appendAuditEntry(tx, auditKey, {
      orgId: args.orgId,
      actor: args.userId,
      action: "policy_changed",
      target: `pause_policy: ${before.pause_policy} -> ${policy}`,
    });
    return { status: "ok", policy, changed: true };
  });
}
