import "server-only";
import { userActor } from "@webhook-co/shared";

import {
  createAgentTrigger,
  revokeAgentTrigger,
  TriggerEndpointNotFoundError,
  type AgentTriggerRecord,
} from "@webhook-co/db/agent-triggers";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";

import { getTenantDb } from "./db";
import { getAuditChainKey } from "./env";

// The agent-trigger create/revoke orchestration — the session counterpart of the api/mcp
// `createAgentTriggerHandlers` seam, one level up from the tx-atomic Lane fns. Each runs under
// withTenant(orgId) as webhook_app (RLS-scoped by the session orgId; any org member may manage the org's
// triggers). No secrets, no sealer, no egress — a trigger is a pure read-consumption registration, so this
// seam is far simpler than the destinations one. Every mutation is audited under the org's audit-chain key.

export { TriggerEndpointNotFoundError };

export interface CreateTriggerInput {
  readonly orgId: string;
  readonly endpointId: string;
  readonly name?: string | null;
  readonly actor: string;
}
export interface RevokeTriggerInput {
  readonly orgId: string;
  readonly triggerId: string;
  readonly actor: string;
}

/**
 * Injectable boundaries for the glue unit tests; the audit-key import is NOT injected so a test still
 * exercises the real key logic. The default binds live env + the Lane fns over the per-request tenant pool.
 */
export interface AgentTriggerDeps {
  create(
    orgId: string,
    endpointId: string,
    name: string | null,
    actor: string,
  ): Promise<AgentTriggerRecord>;
  revoke(orgId: string, triggerId: string, actor: string): Promise<{ id: string } | null>;
}

async function defaultDeps(): Promise<{ deps: AgentTriggerDeps; close: () => Promise<void> }> {
  // Resolve the audit key BEFORE opening the pool (a fail-closed getAuditChainKey must not strand an open
  // pool on its error path), mirroring the destination + endpoint mutation seams.
  const auditKey = await importAuditKey(b64ToBytes(await getAuditChainKey()));
  const app = await getTenantDb();
  return {
    deps: {
      create: (orgId, endpointId, name, actor) =>
        createAgentTrigger(app, { orgId, endpointId, name }, { auditKey, actor: userActor(actor) }),
      revoke: (orgId, triggerId, actor) =>
        revokeAgentTrigger(app, orgId, triggerId, { auditKey, actor: userActor(actor) }),
    },
    close: async () => {
      await app.end({ timeout: 5 }).catch(() => {});
    },
  };
}

async function run<T>(
  injected: AgentTriggerDeps | undefined,
  fn: (deps: AgentTriggerDeps) => Promise<T>,
): Promise<T> {
  const { deps, close } = injected
    ? { deps: injected, close: async () => {} }
    : await defaultDeps();
  try {
    return await fn(deps);
  } finally {
    await close();
  }
}

/**
 * Register an agent trigger for (org, endpoint). Throws {@link TriggerEndpointNotFoundError} for a missing /
 * soft-deleted / cross-org endpoint (the action maps it to NOT_FOUND), and a `CapabilityFault("RATE_LIMITED")`
 * when the org is at its active-trigger cap (the action maps that to friendly copy).
 */
export function createTrigger(
  input: CreateTriggerInput,
  injected?: AgentTriggerDeps,
): Promise<AgentTriggerRecord> {
  return run(injected, (deps) =>
    deps.create(input.orgId, input.endpointId, input.name ?? null, input.actor),
  );
}

/**
 * Soft-revoke a trigger (idempotent). Returns `{ id }` when the trigger exists in the caller's org (whether
 * this call revoked it or it was already revoked), or null for an unknown / cross-org id (→ NOT_FOUND).
 */
export function revokeTrigger(
  input: RevokeTriggerInput,
  injected?: AgentTriggerDeps,
): Promise<{ id: string } | null> {
  return run(injected, (deps) => deps.revoke(input.orgId, input.triggerId, input.actor));
}
