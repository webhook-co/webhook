// Replay-destination allowlist storage (ADR-0081). An org registers the HTTPS URLs that events.replay
// is permitted to deliver to; the closed replay TargetSchema's `{kind:"destination", destinationId}` arm
// references a row here, so a remote replay can never carry a free-form URL. This is a SAFETY/trust +
// auditability control, distinct from S3's per-endpoint outbound routing.
//
// All mutations run as webhook_app under the org's RLS context (withTenant). When `audit` is supplied, a
// tamper-evident wha1/audit_log row is appended IN THE SAME tx — parity with the endpoints + provider-
// secret lifecycle. deleted_at is the single soft-delete marker; the API renders status as a word derived
// from it (active = live, revoked = soft-deleted).

import {
  CapabilityFault,
  replayDestinationsCreate,
  replayDestinationsDelete,
  replayDestinationsList,
  replayDestinationsListSigningSecrets,
  replayDestinationsRotateSigningSecret,
  type AnyCapability,
  type AuthContext,
} from "@webhook-co/contract";
import { canonicalizeAndValidateUrl, newId, type SecretSealer } from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql, type TenantTx } from "./client";
import type { CapabilityHandlers } from "./read-handlers";
import { insertActiveSigningSecret, listSigningSecrets, rotateSigningSecret } from "./signing-keys";

export type ReplayDestinationStatus = "active" | "revoked";

/**
 * Resolve a LIVE replay destination's delivery URL by id, within an EXISTING tenant tx (so it composes
 * with the event/endpoint resolution + the delivery-attempt claim in one transaction). Returns the
 * canonical url, or null if the destination is missing / cross-org / soft-deleted (RLS + the deleted_at
 * filter). The caller maps null → NOT_FOUND (don't leak existence). The connect-time SSRF guard re-runs
 * on this url at delivery — registration-time validation is never trusted as a "safe" flag.
 */
export async function getReplayDestination(
  tx: TenantTx,
  id: string,
): Promise<{ readonly id: string; readonly url: string } | null> {
  const [row] = await tx<{ id: string; url: string }[]>`
    select id, url from replay_destinations
    where id = ${id} and deleted_at is null`;
  return row ? { id: row.id, url: row.url } : null;
}

/** A replay destination as the management surface sees it (no internal columns). */
export interface ReplayDestinationRecord {
  readonly id: string;
  readonly orgId: string;
  readonly url: string;
  readonly label: string | null;
  readonly status: ReplayDestinationStatus;
  readonly createdAt: Date;
  readonly lastValidatedAt: Date | null;
}

/**
 * Control-plane audit context for a replay-destination mutation (add/remove). When supplied, the mutation
 * appends a wha1/audit_log row IN THE SAME tx (atomic with the insert/update). The HMAC key comes from a
 * runtime binding, never the DB role (ADR-0004). Optional so the low-level db tests can exercise the
 * mutation without an audit key; the management handlers always supply it.
 */
export interface ReplayDestinationAudit {
  readonly auditKey: CryptoKey;
  /** Pseudonymous actor (Better Auth user_id), or null for api-key/system actors. */
  readonly actor: string | null;
}

interface ReplayDestinationRow {
  id: string;
  org_id: string;
  url: string;
  label: string | null;
  created_at: Date;
  last_validated_at: Date | null;
  deleted_at: Date | null;
}

function toRecord(r: ReplayDestinationRow): ReplayDestinationRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    url: r.url,
    label: r.label,
    // Single source of truth: live (deleted_at null) = active, soft-deleted = revoked.
    status: r.deleted_at === null ? "active" : "revoked",
    createdAt: r.created_at,
    lastValidatedAt: r.last_validated_at,
  };
}

export interface CreateReplayDestinationInput {
  readonly orgId: string;
  /** The canonical, structurally-validated URL (caller runs canonicalizeAndValidateUrl first). */
  readonly url: string;
  readonly label?: string | null;
  /** Advisory: when the URL last passed a structural/resolve check (set on create). */
  readonly lastValidatedAt?: Date | null;
}

/**
 * Register a replay destination (idempotent on the live (org_id, url)). A re-add of a URL already in the
 * live allowlist returns the EXISTING row WITHOUT a duplicate or a new audit entry — the partial unique
 * index (deleted_at is null) is the arbiter, so a previously-removed URL can be re-added as a fresh row.
 * Runs as webhook_app under the org's RLS context.
 */
export async function createReplayDestination(
  app: Sql,
  input: CreateReplayDestinationInput,
  audit?: ReplayDestinationAudit,
): Promise<ReplayDestinationRecord> {
  const id = newId();
  return withTenant(app, input.orgId, async (tx) => {
    const [inserted] = await tx<ReplayDestinationRow[]>`
      insert into replay_destinations (id, org_id, url, label, last_validated_at)
      values (${id}, ${input.orgId}, ${input.url}, ${input.label ?? null}, ${input.lastValidatedAt ?? null})
      on conflict (org_id, url) where deleted_at is null do nothing
      returning id, org_id, url, label, created_at, last_validated_at, deleted_at`;
    if (inserted) {
      if (audit) {
        await appendAuditEntry(tx, audit.auditKey, {
          orgId: input.orgId,
          actor: audit.actor,
          action: "replay_destination.added",
          target: id,
        });
      }
      return toRecord(inserted);
    }
    // Conflict: this URL is already a live allowlist entry — return it (no duplicate, no audit).
    const [existing] = await tx<ReplayDestinationRow[]>`
      select id, org_id, url, label, created_at, last_validated_at, deleted_at
      from replay_destinations
      where org_id = ${input.orgId} and url = ${input.url} and deleted_at is null`;
    if (!existing) throw new Error("replay_destinations conflict without an existing row");
    return toRecord(existing);
  });
}

/**
 * Register a replay destination AND mint its one-time Standard Webhooks signing secret ATOMICALLY (S3
 * Slice 2). The destination insert + the signing-secret insert commit in ONE tx, and the mint is gated
 * on WINNING the on-conflict-do-nothing insert — so:
 *   - a seal/mint failure rolls back the destination too (never an orphan destination with no secret,
 *     which would silently deliver every replay UNSIGNED), and
 *   - a concurrent create of the same new URL can't double-mint/double-reveal (only the inserter mints;
 *     the loser resolves to the existing row with no secret).
 * On an idempotent re-add of a live URL, `signingSecret` is undefined (the secret was revealed at first
 * create — use rotateSigningSecret for a fresh one). The seal RPC runs inside the tx; acceptable for a
 * low-frequency management op (NOT the delivery hot path, which never holds a tx across an effect).
 */
export async function createReplayDestinationWithSigningSecret(
  app: Sql,
  input: CreateReplayDestinationInput,
  sealer: SecretSealer,
  audit: ReplayDestinationAudit,
): Promise<{ readonly record: ReplayDestinationRecord; readonly signingSecret?: string }> {
  const id = newId();
  return withTenant(app, input.orgId, async (tx) => {
    const [inserted] = await tx<ReplayDestinationRow[]>`
      insert into replay_destinations (id, org_id, url, label, last_validated_at)
      values (${id}, ${input.orgId}, ${input.url}, ${input.label ?? null}, ${input.lastValidatedAt ?? null})
      on conflict (org_id, url) where deleted_at is null do nothing
      returning id, org_id, url, label, created_at, last_validated_at, deleted_at`;
    if (inserted) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId: input.orgId,
        actor: audit.actor,
        action: "replay_destination.added",
        target: id,
      });
      const minted = await insertActiveSigningSecret(tx, input.orgId, id, sealer);
      await appendAuditEntry(tx, audit.auditKey, {
        orgId: input.orgId,
        actor: audit.actor,
        action: "signing_secret.created",
        target: minted.keyId,
      });
      return { record: toRecord(inserted), signingSecret: minted.secret };
    }
    const [existing] = await tx<ReplayDestinationRow[]>`
      select id, org_id, url, label, created_at, last_validated_at, deleted_at
      from replay_destinations
      where org_id = ${input.orgId} and url = ${input.url} and deleted_at is null`;
    if (!existing) throw new Error("replay_destinations conflict without an existing row");
    return { record: toRecord(existing), signingSecret: undefined };
  });
}

/** List an org's LIVE replay destinations (newest first) under its RLS context. */
export async function listReplayDestinations(
  app: Sql,
  orgId: string,
): Promise<ReplayDestinationRecord[]> {
  const rows = await withTenant(app, orgId, async (tx) => {
    return tx<ReplayDestinationRow[]>`
      select id, org_id, url, label, created_at, last_validated_at, deleted_at
      from replay_destinations
      where deleted_at is null
      order by created_at desc, id desc`;
  });
  return rows.map(toRecord);
}

/**
 * Soft-delete (revoke) a live replay destination under the org's RLS context. Returns the id + delete
 * time, or null if no LIVE destination with that id belongs to the org (unknown / cross-org / already-
 * removed → null). When `audit` is supplied, a `replay_destination.removed` row is appended in the same
 * tx — but only if a row actually transitioned (a no-op delete writes no audit).
 */
export async function softDeleteReplayDestination(
  app: Sql,
  orgId: string,
  id: string,
  audit?: ReplayDestinationAudit,
): Promise<{ readonly id: string; readonly deletedAt: Date } | null> {
  const rows = await withTenant(app, orgId, async (tx) => {
    const updated = await tx<{ deleted_at: Date }[]>`
      update replay_destinations set deleted_at = now()
      where id = ${id} and deleted_at is null
      returning deleted_at`;
    if (updated.length > 0 && audit) {
      await appendAuditEntry(tx, audit.auditKey, {
        orgId,
        actor: audit.actor,
        action: "replay_destination.removed",
        target: id,
      });
    }
    return updated;
  });
  const row = rows[0];
  return row ? { id, deletedAt: row.deleted_at } : null;
}

// ── The replayDestinations.* capability handlers (ADR-0081) ───────────────────────────────────────
// These are DELIBERATELY a dedicated factory wired ONLY by apps/api — NOT merged into the shared
// buildCapabilityHandlers map that apps/mcp also builds. Keeping them off the shared map is the
// defense-in-depth that makes the mcp exemption un-driftable (the same pattern as createReplayHandler):
// an agent can never reach the SSRF-egress allowlist even if mcp's dispatch changed. Each handler
// enforces the capability scope FIRST, validates input, then mutates under RLS with an in-tx audit row.

export interface ReplayDestinationHandlerDeps {
  /** webhook_app over the cache-disabled tenant binding — all mutations run here under RLS. */
  readonly tenant: Sql;
  /** Audit-chain HMAC key (AUDIT_CHAIN_HMAC_KEY) — signs the in-tx wha1/audit_log row. */
  readonly auditKey: CryptoKey;
  /**
   * The write-only seal seam (the engine's ProviderSecretSealer over the service binding in prod; a local
   * SecretStore in tests). Used to seal a destination's minted Standard Webhooks signing secret at
   * create/rotate (S3 Slice 2). api never holds the KEK — it can seal, never unseal.
   */
  readonly sealer: SecretSealer;
}

export function createReplayDestinationHandlers(
  deps: ReplayDestinationHandlerDeps,
): CapabilityHandlers {
  function ensureScope(ctx: AuthContext, cap: AnyCapability): void {
    if (!ctx.scopes.includes(cap.auth.scope)) {
      throw new CapabilityFault("FORBIDDEN", `missing required scope: ${cap.auth.scope}`);
    }
  }
  const handlers: CapabilityHandlers = new Map();

  handlers.set(replayDestinationsCreate.name, async (ctx, input) => {
    ensureScope(ctx, replayDestinationsCreate);
    const parsed = replayDestinationsCreate.input.safeParse(input);
    if (!parsed.success) {
      throw new CapabilityFault(
        "VALIDATION_ERROR",
        parsed.error.issues[0]?.message ?? "invalid input",
      );
    }
    // Re-run the structural guard to obtain the CANONICAL url to store (the contract superRefine only
    // validated it). A miss here is defensive (post-validation) → VALIDATION_ERROR, never a 500. The
    // AUTHORITATIVE private-range check runs at DELIVERY time (the engine connect-time guard, 1b).
    const validated = canonicalizeAndValidateUrl(parsed.data.url);
    if (!validated.ok) throw new CapabilityFault("VALIDATION_ERROR", "invalid url");
    // Create the destination AND mint its one-time signing secret atomically (S3 Slice 2): the secret
    // mint commits in the same tx as the destination + is gated on winning the insert, so we can never
    // leave a destination without a secret (silent-unsigned) nor double-mint on a concurrent create.
    // signingSecret is omitted on an idempotent re-add (the secret was revealed at first create).
    const { record, signingSecret } = await createReplayDestinationWithSigningSecret(
      deps.tenant,
      {
        orgId: ctx.orgId,
        url: validated.url,
        label: parsed.data.label ?? null,
        lastValidatedAt: new Date(), // the structural check passed now (advisory)
      },
      deps.sealer,
      { auditKey: deps.auditKey, actor: ctx.userId ?? null },
    );
    return { ...record, signingSecret };
  });

  handlers.set(replayDestinationsList.name, async (ctx, input) => {
    ensureScope(ctx, replayDestinationsList);
    const parsed = replayDestinationsList.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    const items = await listReplayDestinations(deps.tenant, ctx.orgId);
    return { items };
  });

  handlers.set(replayDestinationsDelete.name, async (ctx, input) => {
    ensureScope(ctx, replayDestinationsDelete);
    const parsed = replayDestinationsDelete.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    const removed = await softDeleteReplayDestination(
      deps.tenant,
      ctx.orgId,
      parsed.data.destinationId,
      { auditKey: deps.auditKey, actor: ctx.userId ?? null },
    );
    if (removed === null) throw new CapabilityFault("NOT_FOUND", "replay destination not found");
    return removed;
  });

  handlers.set(replayDestinationsRotateSigningSecret.name, async (ctx, input) => {
    ensureScope(ctx, replayDestinationsRotateSigningSecret);
    const parsed = replayDestinationsRotateSigningSecret.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    // Resolve the destination FIRST so an unknown / cross-org / soft-deleted id is NOT_FOUND (not a 500
    // from the signing_keys composite FK), and we never leak existence cross-org.
    const dest = await withTenant(deps.tenant, ctx.orgId, (tx) =>
      getReplayDestination(tx, parsed.data.destinationId),
    );
    if (!dest) throw new CapabilityFault("NOT_FOUND", "replay destination not found");
    const minted = await rotateSigningSecret(
      deps.tenant,
      { orgId: ctx.orgId, destinationId: parsed.data.destinationId },
      deps.sealer,
      { auditKey: deps.auditKey, actor: ctx.userId ?? null },
    );
    return {
      destinationId: parsed.data.destinationId,
      keyId: minted.keyId,
      signingSecret: minted.secret,
    };
  });

  handlers.set(replayDestinationsListSigningSecrets.name, async (ctx, input) => {
    ensureScope(ctx, replayDestinationsListSigningSecrets);
    const parsed = replayDestinationsListSigningSecrets.input.safeParse(input);
    if (!parsed.success) throw new CapabilityFault("VALIDATION_ERROR", "invalid input");
    const dest = await withTenant(deps.tenant, ctx.orgId, (tx) =>
      getReplayDestination(tx, parsed.data.destinationId),
    );
    if (!dest) throw new CapabilityFault("NOT_FOUND", "replay destination not found");
    const items = await listSigningSecrets(deps.tenant, ctx.orgId, parsed.data.destinationId);
    return { items };
  });

  return handlers;
}
