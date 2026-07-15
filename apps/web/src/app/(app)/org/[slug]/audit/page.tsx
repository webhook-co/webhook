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
import { requireActiveOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Audit log · webhook.co",
};

export default async function AuditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // subPath: a mis-cased or retired slug 308s to the canonical URL with this deep link intact.
  const { orgId, userId, role, slug: orgSlug } = await requireActiveOrgAccess(slug, "/audit");

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
        loadMore={loadMoreAuditAction.bind(null, orgSlug)}
        verifyChain={verifyAuditChainAction.bind(null, orgSlug)}
        initialAuth={initialAuth}
        loadMoreAuth={loadMoreAuthAuditAction.bind(null, orgSlug)}
        verifyAuthChain={verifyAuthAuditChainAction.bind(null, orgSlug)}
        currentUserId={userId}
      />
    </PageContainer>
  );
}
