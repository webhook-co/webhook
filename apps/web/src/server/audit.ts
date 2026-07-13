import "server-only";

import { listAuditEntries } from "@webhook-co/db/audit-append";
import { listAuthAuditEntries } from "@webhook-co/db/auth-audit";
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

// ---- The GOVERNANCE chain (aae1 / auth_audit_event) -------------------------------------------------
//
// Everything the collaboration lane emits — invites, role changes, removals, key mints, grants — lands on
// THIS chain, not audit_log. Without it, an owner opening the audit log to answer "who invited whom, who
// removed whom" would find none of it.

export interface AuthAuditItem {
  readonly seq: number;
  readonly eventType: string;
  /** The acting user id, or null for a system action. Pseudonymous — never an email. */
  readonly actor: string | null;
  readonly targetId: string | null;
  /** Small string map (e.g. `{from: "member", to: "admin"}`). Never contains an email — see invites.ts. */
  readonly metadata: Record<string, string> | null;
  readonly createdAt: string;
}

export type AuthAuditResult =
  | {
      readonly status: "ok";
      readonly items: readonly AuthAuditItem[];
      readonly nextSeq: number | null;
    }
  | { readonly status: "error" };

/** Flatten metadata to displayable strings. Anything non-scalar is dropped rather than JSON-dumped at a user. */
function toMetadata(raw: unknown): Record<string, string> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** A page of the org's governance chain, newest first. Keyset on `seq`; never throws. */
export async function loadAuthAudit(
  orgId: string,
  afterSeq: number | null = null,
): Promise<AuthAuditResult> {
  try {
    const page = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) =>
        listAuthAuditEntries(tx, { afterSeq, limit: AUDIT_PAGE_SIZE }),
      ),
    );
    return {
      status: "ok",
      items: page.items.map((r) => ({
        seq: r.seq,
        eventType: r.eventType,
        actor: r.actor,
        targetId: r.targetId,
        metadata: toMetadata(r.metadata),
        createdAt: r.createdAt.toISOString(),
      })),
      nextSeq: page.nextSeq,
    };
  } catch (error) {
    logActionError("audit.auth_list_failed", error);
    return { status: "error" };
  }
}
