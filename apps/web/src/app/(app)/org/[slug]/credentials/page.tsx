import { CAPABILITY_SCOPES } from "@webhook-co/contract/capability";
import { PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { CredentialsManager } from "@/components/credentials-manager";
import { createApiKey, revokeApiKey, revokeGrant } from "@/server/credential-actions";
import { loadCredentials } from "@/server/credentials";
import { requireActiveOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "API keys & devices · webhook.co",
};

export default async function CredentialsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireActiveOrgAccess(slug, "/credentials");
  const result = await loadCredentials(session.orgId);

  return (
    <PageContainer>
      {/* Header + the "Create key" primary action live inside the manager (Team pattern) — the create dialog
          owns state the header would otherwise have to lift. */}
      <CredentialsManager
        initialResult={result}
        createKey={createApiKey.bind(null, session.slug)}
        revokeKey={revokeApiKey.bind(null, session.slug)}
        revokeGrant={revokeGrant.bind(null, session.slug)}
        scopes={CAPABILITY_SCOPES}
      />
    </PageContainer>
  );
}
