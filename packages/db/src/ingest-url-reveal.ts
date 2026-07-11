// The control-plane side of the ingest-URL reveal (S8-remainder Slice 2 / ADR-0101): rate-limiting +
// tamper-evident audit. The UNSEAL itself is engine-only (the KEK never leaves the engine); this module is
// what the CALLER (api/mcp/web, which hold the audit HMAC key) runs around the reveal RPC. Shared so api/mcp
// (via the write handler) and the web DB-direct session seam can't drift on the cap or the audit action.

// Leaf import (not the @webhook-co/contract barrel): apps/web pulls this module DB-direct under Turbopack,
// where a named binding from a transpiled-package `export *` barrel resolves to `undefined` at runtime — so
// `new CapabilityFault` would throw "not a constructor" on the RATE_LIMITED path (see [[turbopack-contract-barrel]]).
import { CapabilityFault } from "@webhook-co/contract/capability";
import type { AuditActorInput } from "@webhook-co/shared";

import { appendAuditEntry } from "./audit-append";
import { withTenant, type Sql } from "./client";

/** The audit action a reveal writes — a bearer-credential disclosure must be attributable + detectable. */
export const INGEST_URL_REVEAL_AUDIT_ACTION = "endpoint.ingest_url_revealed";

/** Reveal cap: at most this many disclosures per ORG per window. Org-wide (not per-endpoint / per-key) on
 *  purpose — the audit `actor` is null for api-key bearers, so the org is the meaningful abuse unit, and a
 *  compromised endpoints:write bearer's repeated reveals are what we bound. Set ABOVE the per-org endpoint
 *  soft cap (DEFAULT_MAX_ENDPOINTS_PER_ORG = 100) so a legitimate "reveal every endpoint" sweep fits inside
 *  one window and never false-trips; it caps hammering (thousands of reveals/min → KMS + audit spam), not
 *  real bulk reveal. (Exfiltration of DISTINCT URLs is already bounded by the ≤100 endpoints/org regardless.) */
export const INGEST_URL_REVEAL_MAX_PER_WINDOW = 120;
export const INGEST_URL_REVEAL_WINDOW_SECONDS = 60;

/**
 * Enforce the per-org reveal rate limit BEFORE the unseal (so a throttled caller never even reaches the
 * engine/KMS). Counts recent `endpoint.ingest_url_revealed` audit rows under the org's RLS (webhook_app);
 * over the cap → CapabilityFault RATE_LIMITED. Audit-derived (no new table) — the rows we already write are
 * the counter. A tiny check-then-append race can transiently allow cap+N; it's an abuse backstop, not a
 * security boundary (the write-scope gate + the audit trail are).
 */
export async function enforceIngestUrlRevealRateLimit(app: Sql, orgId: string): Promise<void> {
  const rows = await withTenant(
    app,
    orgId,
    (tx) =>
      tx<{ count: number }[]>`
      select count(*)::int as count
      from audit_log
      where action = ${INGEST_URL_REVEAL_AUDIT_ACTION}
        and created_at > now() - make_interval(secs => ${INGEST_URL_REVEAL_WINDOW_SECONDS})`,
  );
  const count = rows[0]?.count ?? 0;
  if (count >= INGEST_URL_REVEAL_MAX_PER_WINDOW) {
    throw new CapabilityFault(
      "RATE_LIMITED",
      "too many ingest-URL reveals; please retry in a moment",
    );
  }
}

/**
 * Append the tamper-evident `endpoint.ingest_url_revealed` audit row for a disclosure, under the org's RLS
 * context. Call ONLY when a URL was actually revealed (a null "rotate to reveal" result discloses nothing).
 * actor may be null (api-key bearers carry no user_id).
 */
export async function appendIngestUrlRevealAudit(
  app: Sql,
  auditKey: CryptoKey,
  orgId: string,
  actor: AuditActorInput,
  endpointId: string,
): Promise<void> {
  await withTenant(app, orgId, (tx) =>
    appendAuditEntry(tx, auditKey, {
      orgId,
      actor,
      action: INGEST_URL_REVEAL_AUDIT_ACTION,
      target: endpointId,
    }),
  );
}
