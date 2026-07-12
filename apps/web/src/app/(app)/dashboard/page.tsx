import {
  Banner,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageContainer,
  PageHeader,
} from "@webhook-co/ui";
import type { Metadata } from "next";
import Link from "next/link";

import { DeliveryChart } from "@/components/delivery-chart";
import { NeedsAttention } from "@/components/needs-attention";
import { buildDashboardChart } from "@/lib/dashboard-chart";
import { deriveAttention } from "@/lib/dashboard-attention";
import { DASHBOARD_WINDOW_DAYS, loadDashboard } from "@/server/dashboard";
import { verifySession } from "@/server/session";

export const metadata: Metadata = {
  title: "Overview · webhook.co",
};

/** A labelled number tile (delivered / failed / p95). Plain, not a full Card — three read at a glance. */
function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-hairline bg-surface p-4">
      <span className="text-sm text-fg-secondary">{label}</span>
      <span className="text-2xl font-semibold tabular-nums tracking-heading text-fg">{value}</span>
      {hint ? <span className="text-xs text-fg-muted">{hint}</span> : null}
    </div>
  );
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;
  return `${ms} ms`;
}

export default async function DashboardPage() {
  const session = await verifySession();
  const data = await loadDashboard(session.orgId);
  const chart = buildDashboardChart(data.series, DASHBOARD_WINDOW_DAYS, Date.now());
  const attention = deriveAttention({
    pastDue: data.pastDue,
    paused: data.paused,
    disabledDestinationCount: data.disabledDestinationCount,
    deadCount: chart.totalDead,
  });

  return (
    <PageContainer>
      <PageHeader
        title="Overview"
        description="How your webhooks are flowing — inbound capture and outbound delivery at a glance."
      />

      {attention.length > 0 ? <NeedsAttention items={attention} /> : null}

      {!data.seriesOk ? (
        <Banner tone="danger">
          We couldn&apos;t load your delivery stats. Refresh to try again — the rest of your data is
          fine.
        </Banner>
      ) : chart.hasAnyDelivery ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile
              label="Delivered"
              value={formatCount(chart.totalDelivered)}
              hint={`last ${DASHBOARD_WINDOW_DAYS} days`}
            />
            <StatTile
              label="Failed"
              value={formatCount(chart.totalFailed)}
              hint="retries exhausted or blocked"
            />
            <StatTile
              label="p95 latency"
              value={formatLatency(chart.latestP95Ms)}
              hint="most recent day measured"
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Delivery outcomes</CardTitle>
              <CardDescription>
                Daily delivered vs failed. Updated hourly, so the last hour may not be reflected
                yet.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DeliveryChart model={chart} />
            </CardContent>
          </Card>
        </>
      ) : (
        <EmptyState
          title="No deliveries yet"
          description="Point a provider at your ingest URL, then replay a captured event to a destination. Once webhooks start flowing, this is where you'll watch them land."
          action={
            <Button asChild>
              <Link href="/endpoints">Send a test webhook</Link>
            </Button>
          }
        />
      )}
    </PageContainer>
  );
}
