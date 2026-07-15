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

import { DashboardDateFilter } from "@/components/dashboard-date-filter";
import { DeliveryChart } from "@/components/delivery-chart";
import { NeedsAttention } from "@/components/needs-attention";
import { buildDashboardChart } from "@/lib/dashboard-chart";
import { deriveAttention } from "@/lib/dashboard-attention";
import { resolveDashboardWindow } from "@/lib/dashboard-window";
import { loadDashboard } from "@/server/dashboard";
import { requireActiveOrgAccess } from "@/server/org-access";

/** First value of a possibly-repeated search param (a hand-edited `?range=a&range=b` → array). */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

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
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  // Round to one decimal first, THEN choose precision, so 9999ms reads "10 s" (not "10.0 s") like 10000ms.
  const oneDecimal = Math.round(seconds * 10) / 10;
  return oneDecimal >= 10 ? `${Math.round(seconds)} s` : `${oneDecimal.toFixed(1)} s`;
}

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    range?: string | string[];
    from?: string | string[];
    to?: string | string[];
    invite?: string | string[];
    org?: string | string[];
  }>;
}) {
  const { slug } = await params;
  const [session, sp] = await Promise.all([
    requireActiveOrgAccess(slug, "/dashboard"),
    searchParams,
  ]);
  const inviteOutcome = first(sp.invite);
  const orgOutcome = first(sp.org);
  const window = resolveDashboardWindow(
    { range: first(sp.range), from: first(sp.from), to: first(sp.to) },
    Date.now(),
  );
  const data = await loadDashboard(session.orgId, { days: window.days, endMs: window.endMs });
  const chart = buildDashboardChart(data.series, window.days, window.endMs);
  const attention = deriveAttention({
    slug: session.slug,
    pastDue: data.pastDue,
    paused: data.paused,
    disabledDestinationCount: data.disabledDestinationCount,
    deadCount: chart.totalDead,
  });

  return (
    <PageContainer>
      <PageHeader title="Overview" actions={<DashboardDateFilter />} />

      {inviteOutcome === "accepted" ? (
        <Banner tone="ok">You&apos;ve joined the organization.</Banner>
      ) : inviteOutcome === "invalid" ? (
        <Banner tone="danger">
          That invite couldn&apos;t be accepted — it may have expired, been revoked, or been sent to
          a different email. Ask for a fresh link.
        </Banner>
      ) : inviteOutcome === "error" ? (
        <Banner tone="danger">
          Something went wrong accepting that invite. Open the link again to retry.
        </Banner>
      ) : null}

      {orgOutcome === "denied" ? (
        <Banner tone="danger">
          We couldn&apos;t switch to that organization. You may no longer be a member of it.
        </Banner>
      ) : orgOutcome === "left" ? (
        <Banner tone="ok">You&apos;ve left the organization.</Banner>
      ) : null}

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
              hint={window.label.toLowerCase()}
            />
            <StatTile
              label="Failed"
              value={formatCount(chart.totalFailed)}
              hint="retries exhausted or blocked"
            />
            <StatTile
              label="p95 delivery time"
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
              <Link href={`/org/${session.slug}/endpoints`}>Send a test webhook</Link>
            </Button>
          }
        />
      )}
    </PageContainer>
  );
}
