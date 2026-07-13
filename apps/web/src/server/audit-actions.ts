"use server";

import { readAuditChain } from "@webhook-co/db/audit-append";
import { withTenant } from "@webhook-co/db/client";
import { isAuditReaderRole, verifyAuditChain, type AuditChainResult } from "@webhook-co/shared";
import { importAuditKey } from "@webhook-co/shared/audit";
import { b64ToBytes } from "@webhook-co/shared/bytes";

import { loadAudit, type AuditResult } from "./audit";
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
export async function loadMoreAuditAction(formData: FormData): Promise<LoadMoreAuditResult> {
  const { orgId, role } = await requireOrgAccess();
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
 * can actually check it. Reads every row and walks the hash links (verifyAuditChain), so it reports the FIRST
 * break with its seq and an operator-readable detail rather than a bare boolean.
 *
 * Deliberately NOT cross-checked against the R2 anchor here: that's the external truncation guard and needs
 * an R2 binding the web app doesn't have. This is the internal-consistency half, which is self-contained.
 */
export async function verifyAuditChainAction(): Promise<VerifyChainResult> {
  const { orgId, role } = await requireOrgAccess();
  if (!isAuditReaderRole(role)) return { status: "forbidden" };

  try {
    const key = await importAuditKey(b64ToBytes(await getAuditChainKey()));
    const rows = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) => readAuditChain(tx, orgId)),
    );
    return { status: "ok", verification: await verifyAuditChain(key, orgId, rows) };
  } catch (error) {
    logActionError("audit.verify_failed", error);
    return { status: "error" };
  }
}
