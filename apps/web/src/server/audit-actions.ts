"use server";

import { verifyAuditChainPaged } from "@webhook-co/db/audit-append";
import { readAuthAuditChain, verifyAuthAuditChain } from "@webhook-co/db/auth-audit";
import { withTenant } from "@webhook-co/db/client";
import { isAuditReaderRole, type AuditChainResult } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";

import { loadAudit, loadAuthAudit, type AuditResult, type AuthAuditResult } from "./audit";
import { logActionError } from "./action-log";
import { withTenantDb } from "./db";
import { getAuditChainKey } from "./env";
import { requireOrgAccess } from "./org-access";

// Audit server actions (Lane 2.8). Both gate on requireOrgAccess AND on isAuditReaderRole (owner/admin) —
// the same authority the mint ceiling enforces for an `audit:read` key. Without that second check a member
// refused a key over the API could read the identical chain in the browser, which would make the ceiling
// decorative.

export type LoadMoreAuditResult =
  { readonly status: "ok"; readonly result: AuditResult } | { readonly status: "forbidden" };

/** The next page of the chain (keyset on seq). Owner/admin only. */
export async function loadMoreAuditAction(
  slug: string,
  formData: FormData,
): Promise<LoadMoreAuditResult> {
  // No subPath: actions don't render, so there's nothing to redirect — they act on the resolved org.
  const { orgId, role } = await requireOrgAccess(slug);
  if (!isAuditReaderRole(role)) return { status: "forbidden" };

  const raw = String(formData.get("afterSeq") ?? "");
  const afterSeq = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(afterSeq) || afterSeq <= 0) {
    return { status: "ok", result: { status: "error" } };
  }
  return { status: "ok", result: await loadAudit(orgId, afterSeq) };
}

export type VerifyChainResult =
  | { readonly status: "ok"; readonly verification: AuditChainResult }
  | { readonly status: "forbidden" }
  | { readonly status: "error" };

/**
 * Recompute the whole chain and report whether it holds — the point of a tamper-evident log is that someone
 * can actually check it. Streams the chain a page at a time (verifyAuditChainPaged, #636) and walks the hash
 * links, so it reports the FIRST break with its seq and an operator-readable detail rather than a bare
 * boolean — without ever holding the whole chain, or one DB connection, for the length of the verification.
 *
 * Deliberately NOT cross-checked against the R2 anchor here: that's the external truncation guard and needs
 * an R2 binding the web app doesn't have. This is the internal-consistency half, which is self-contained.
 */
export async function verifyAuditChainAction(slug: string): Promise<VerifyChainResult> {
  const { orgId, role } = await requireOrgAccess(slug);
  if (!isAuditReaderRole(role)) return { status: "forbidden" };

  try {
    const key = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    // Stream the chain page-by-page (#636): reading every row into memory is a Worker OOM risk that grows
    // with org age. verifyAuditChainPaged carries the prior page's tail so the hash-chain checks still hold,
    // and opens its own short transaction per page (so it takes the pool, not a tx).
    const verification = await withTenantDb((app) => verifyAuditChainPaged(app, orgId, key));
    return { status: "ok", verification };
  } catch (error) {
    logActionError("audit.verify_failed", error);
    return { status: "error" };
  }
}

// ---- The GOVERNANCE chain (aae1) --------------------------------------------------------------------
// Same role gate, same shape. Two chains, one dialect.

export type LoadMoreAuthAuditResult =
  { readonly status: "ok"; readonly result: AuthAuditResult } | { readonly status: "forbidden" };

/** The next page of the governance chain. Owner/admin only. */
export async function loadMoreAuthAuditAction(
  slug: string,
  formData: FormData,
): Promise<LoadMoreAuthAuditResult> {
  const { orgId, role } = await requireOrgAccess(slug);
  if (!isAuditReaderRole(role)) return { status: "forbidden" };

  const afterSeq = Number.parseInt(String(formData.get("afterSeq") ?? ""), 10);
  if (!Number.isSafeInteger(afterSeq) || afterSeq <= 0) {
    return { status: "ok", result: { status: "error" } };
  }
  return { status: "ok", result: await loadAuthAudit(orgId, afterSeq) };
}

/**
 * Recompute the governance chain. Until Lane 2.10 `aae1` had only a per-ROW verifier — which cannot see the
 * attacks a chain exists to detect (a deleted row's seq gap, a rewritten link, a forked seq). This walks it.
 */
export async function verifyAuthAuditChainAction(slug: string): Promise<VerifyChainResult> {
  const { orgId, role } = await requireOrgAccess(slug);
  if (!isAuditReaderRole(role)) return { status: "forbidden" };

  try {
    const key = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    const rows = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) => readAuthAuditChain(tx, orgId)),
    );
    return { status: "ok", verification: await verifyAuthAuditChain(key, orgId, rows) };
  } catch (error) {
    logActionError("audit.auth_verify_failed", error);
    return { status: "error" };
  }
}
