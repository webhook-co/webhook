import { CAPABILITY_SCOPES } from "@webhook-co/contract/capability";
import { PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { CredentialsManager } from "@/components/credentials-manager";
import { createApiKey, revokeApiKey, revokeGrant } from "@/server/credential-actions";
import { loadCredentials } from "@/server/credentials";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "API keys & devices · webhook.co",
};

export default async function CredentialsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireOrgAccess(slug, "/credentials");
  const result = await loadCredentials(session.orgId);

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">API keys &amp; devices</h1>
        <p className="leading-snug text-fg-secondary">
          The keys and devices authorized for your organization. Revoking a device cascades to the
          keys minted under it.
        </p>
      </div>
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
