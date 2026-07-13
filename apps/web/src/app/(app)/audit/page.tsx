import { isAuditReaderRole } from "@webhook-co/shared";
import { Banner, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { AuditLog } from "@/components/audit-log";
import { loadAudit, loadAuthAudit } from "@/server/audit";
import {
  loadMoreAuditAction,
  loadMoreAuthAuditAction,
  verifyAuditChainAction,
  verifyAuthAuditChainAction,
} from "@/server/audit-actions";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Audit log · webhook.co",
};

export default async function AuditPage() {
  const { orgId, userId, role } = await requireOrgAccess();

  // Owner/admin only — the same authority the mint ceiling enforces for an `audit:read` key. Without this a
  // member refused a key over the API could read the identical chain here, and the ceiling would be
  // decorative. Show-and-explain rather than a 404: they can see the page exists and why they can't read it.
  if (!isAuditReaderRole(role)) {
    return (
      <PageContainer size="narrow">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Audit log</h1>
        <Banner tone="warn">
          Only owners and admins can read the audit log — it&apos;s the organization&apos;s
          compliance record. Ask an owner if you need access.
        </Banner>
      </PageContainer>
    );
  }

  const [initial, initialAuth] = await Promise.all([loadAudit(orgId), loadAuthAudit(orgId)]);

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Audit log</h1>
        <p className="leading-snug text-fg-secondary">
          An append-only record of every change to this organization. Each entry is hash-chained to
          the one before it, so you can check the record hasn&apos;t been altered.
        </p>
      </div>
      <AuditLog
        initial={initial}
        loadMore={loadMoreAuditAction}
        verifyChain={verifyAuditChainAction}
        initialAuth={initialAuth}
        loadMoreAuth={loadMoreAuthAuditAction}
        verifyAuthChain={verifyAuthAuditChainAction}
        currentUserId={userId}
      />
    </PageContainer>
  );
}
