import { Banner, PageContainer } from "@webhook-co/ui";
import type { Metadata } from "next";

import { AgentTriggersManager, type EndpointOption } from "@/components/agent-triggers-manager";
import { loadTriggers } from "@/server/agent-triggers";
import { loadEndpoints } from "@/server/endpoints";
import { requireOrgAccess } from "@/server/org-access";

export const metadata: Metadata = {
  title: "Triggers · webhook.co",
};

export default async function TriggersPage() {
  const session = await requireOrgAccess();
  const [triggers, endpoints] = await Promise.all([
    loadTriggers(session.orgId),
    loadEndpoints(session.orgId),
  ]);

  // The endpoint picker needs the org's endpoints; if that read faults we still render (the create form
  // shows "create an endpoint first"), but a triggers-list fault is the page's error state.
  const endpointOptions: EndpointOption[] =
    endpoints.status === "ok" ? endpoints.endpoints.map((e) => ({ id: e.id, name: e.name })) : [];

  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Triggers</h1>
        <p className="leading-snug text-fg-secondary">
          Wake an MCP agent when an endpoint captures a new event. The agent consumes events over
          MCP — a pushed trigger, not a poll.
        </p>
      </div>

      {triggers.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load triggers. Refresh to try again.</Banner>
      ) : (
        <AgentTriggersManager initial={triggers.items} endpoints={endpointOptions} />
      )}
    </PageContainer>
  );
}
