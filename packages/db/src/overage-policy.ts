// The overage opt-in setter (WS3). A paid org toggles whether usage past its included volume is BILLED
// (pause_policy 'allow' = overage on) or the org is PAUSED at the cap and never billed past it
// (pause_policy 'pause' = overage off, the default). The flip is an admin-gated, audited policy change
// (SEC-RLS-08). It ALSO durably reconciles enforcement in the SAME transaction: after flipping the policy it
// runs evaluateOrgCap, which flips `ingest_paused` (the source of truth the ingest cold-lookup reads) to
// match — so an org that turns overage OFF is paused, and one that turns it ON is resumed, atomically with
// the policy change. The caller's engine RPC then only REFRESHES the KV ingest cache (best-effort, TTL-
// backstopped); it is never load-bearing for correctness, so a missing/failing RPC can't leave the org
// ingesting past its cap. The KV cache lives in the engine, which is why eviction stays out of this tx.

import { isBillingManagerRole, type PausePolicy } from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";
import { evaluateOrgCap } from "./cap-producer";
import type { MembershipRole } from "./orgs";

/** The result of a toggle attempt. `changed` = a real flip (vs a no-op set to the current value);
 *  `transitioned` = the durable ingest_paused pause state also flipped (→ the caller should refresh the KV
 *  cache). A no-op or a same-state re-eval leaves `transitioned:false`. */
export type SetOverageResult =
  | {
      readonly status: "ok";
      readonly policy: PausePolicy;
      readonly changed: boolean;
      readonly transitioned: boolean;
    }
  /** The caller isn't an owner/admin of the org — a policy change is admin-only (SEC-RLS-08). */
  | { readonly status: "forbidden" }
  /** No org_limits row: a Free org has no paid plan to bill overage against, so it can't opt in. */
  | { readonly status: "no_subscription" };

/**
 * Flip `org_limits.pause_policy` for `orgId` to reflect `enabled` (true = overage on = 'allow'), then
 * durably reconcile `ingest_paused` — all in ONE tenant transaction, so an unauthorized caller writes
 * nothing, an authorized flip always carries its audit row, and enforcement never lags the policy in the
 * durable store. Idempotent: setting the policy to its current value writes nothing (`changed:false`).
 *
 * @param auditKey the audit-chain HMAC key (from the runtime binding).
 * @param args.now injected clock (ms) + `defaultEventCap` (Free tier figure) threaded to evaluateOrgCap.
 */
export async function setOverageEnabled(
  app: Sql,
  auditKey: CryptoKey,
  args: {
    orgId: string;
    userId: string;
    enabled: boolean;
    now: number;
    defaultEventCap: number | null;
  },
): Promise<SetOverageResult> {
  const policy: PausePolicy = args.enabled ? "allow" : "pause";
  return withTenant(app, args.orgId, async (tx): Promise<SetOverageResult> => {
    const [member] = await tx<{ role: MembershipRole }[]>`
      select role from memberships where org_id = ${args.orgId} and user_id = ${args.userId} limit 1`;
    if (!member || !isBillingManagerRole(member.role)) return { status: "forbidden" };

    const [before] = await tx<{ pause_policy: PausePolicy }[]>`
      select pause_policy from org_limits`;
    if (!before) return { status: "no_subscription" }; // Free org (no paid mirror) can't enable overage

    if (before.pause_policy === policy) {
      return { status: "ok", policy, changed: false, transitioned: false };
    }

    await tx`update org_limits set pause_policy = ${policy}`;
    await appendAuditEntry(tx, auditKey, {
      orgId: args.orgId,
      actor: args.userId,
      action: "policy_changed",
      target: `pause_policy: ${before.pause_policy} -> ${policy}`,
    });
    // Durably reconcile enforcement in THIS tx: evaluateOrgCap reads the just-written pause_policy and flips
    // ingest_paused to match (pause an over-cap org that turned overage off; resume one that turned it on).
    // This is the correctness guarantee — the ingest cold-lookup reads ingest_paused, so it's right the
    // instant this commits, with no dependency on the (best-effort) cache-eviction RPC.
    const evaluation = await evaluateOrgCap(tx, {
      orgId: args.orgId,
      now: args.now,
      defaultEventCap: args.defaultEventCap,
    });
    return { status: "ok", policy, changed: true, transitioned: evaluation.transition !== null };
  });
}
