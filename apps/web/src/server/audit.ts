import "server-only";

import { listAuditEntries } from "@webhook-co/db/audit-append";
import { withTenant } from "@webhook-co/db/client";
import { describeAuditActor, parseAuditActor } from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";

// The audit read for the dashboard (Lane 2.8). A tamper-evident chain nobody can look at is worth very
// little — this is the surface that makes it real.
//
// It is DB-DIRECT rather than routed through a contract capability, matching the dashboard's established
// pattern for a read it owns. `audit.verify` IS a capability (api/cli/mcp) and the verify button binds it on
// web; a separate `audit.list` capability would additionally oblige a CLI command into existence (the parity
// mirror auto-binds CLI for every registered capability) for zero benefit here.
//
// AUTHZ lives in the actions/page (isAuditReaderRole — owner/admin), matching the mint ceiling, which already
// refuses a `member` an `audit:read` key. RLS scopes the rows; the role gate decides who may ask at all.

export const AUDIT_PAGE_SIZE = 50;

export interface AuditItem {
  readonly seq: number;
  /** Dot-namespaced and OPEN — new actions ship without a schema change, so render, don't switch. */
  readonly action: string;
  readonly target: string | null;
  /** Human-readable actor ("You", "An API key", "System", "Unattributed"), derived from the prefixed form. */
  readonly actor: string;
  readonly createdAt: string;
}

export type AuditResult =
  | { readonly status: "ok"; readonly items: readonly AuditItem[]; readonly nextSeq: number | null }
  | { readonly status: "error" };

/** Project a stored row to something safe and readable in a browser (no hashes — they're noise here). */
function toItem(row: {
  seq: number;
  action: string;
  target: string | null;
  actor: string | null;
  createdAt: Date;
}): AuditItem {
  return {
    seq: row.seq,
    action: row.action,
    target: row.target,
    actor: describeAuditActor(parseAuditActor(row.actor)),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A page of the org's audit chain, newest first. Keyset on `seq`, so paging can neither skip nor duplicate a
 * row — which for an audit trail is the whole point. Never throws: a fault degrades to an error result so the
 * page can say so rather than 500.
 */
export async function loadAudit(
  orgId: string,
  afterSeq: number | null = null,
): Promise<AuditResult> {
  try {
    const page = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) => listAuditEntries(tx, { afterSeq, limit: AUDIT_PAGE_SIZE })),
    );
    return { status: "ok", items: page.items.map(toItem), nextSeq: page.nextSeq };
  } catch (error) {
    logActionError("audit.list_failed", error);
    return { status: "error" };
  }
}
