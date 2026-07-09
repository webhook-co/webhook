import { Banner, Button } from "@webhook-co/ui";
import type { Metadata } from "next";

import { loadBillingPanel } from "@/server/billing";
import type { BillingPanel } from "@/server/billing-panel";
import { openBillingPortalAction, startCheckoutAction } from "@/server/plan-actions";
import { loadUsage } from "@/server/usage";
import { verifySession } from "@/server/session";
import type { UsageSummary } from "@webhook-co/shared";

/** Plan display names. NO price or included-volume figure lives in this repo — Stripe's hosted Checkout is
 *  the only surface that shows an amount, and the usage card shows the org's own cap from the DB. */
const PLAN_LABEL: Record<string, string> = { pro: "Pro", scale: "Scale" };

/** What went wrong coming back from a billing action, in the user's words. */
const BILLING_ERROR: Record<string, string> = {
  unknown_plan: "That plan isn't available. Pick one below, or contact us about Enterprise.",
  no_customer: "You don't have a subscription to manage yet.",
  error: "We couldn't reach our payment provider. Nothing was charged — try again.",
  disabled: "Billing isn't available right now.",
};

export const metadata: Metadata = {
  title: "Usage · webhook.co",
};

const fmtCount = (n: number): string => n.toLocaleString("en-US");
const fmtDate = (d: Date): string =>
  d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ billing?: string | string[] }>;
}) {
  const session = await verifySession();
  const [result, panel, sp] = await Promise.all([
    loadUsage(session.orgId),
    loadBillingPanel(session.orgId),
    searchParams,
  ]);
  const flag = Array.isArray(sp.billing) ? sp.billing[0] : sp.billing;
  const billingError = flag && flag !== "ok" ? (BILLING_ERROR[flag] ?? BILLING_ERROR.error) : null;

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Usage</h1>
        {/* Disclosure (constitution: the billable unit is stated up front). Single-dimension, no
            per-step counters — so the number here is the whole story. */}
        <p className="leading-snug text-fg-secondary">
          Metering is single-dimension: one event is a captured request to an endpoint, <em>or</em>{" "}
          one delivery to a destination. Retries never count. You&apos;re billed on events — no
          per-step or per-feature charges, and every feature is on every plan.
        </p>
      </div>

      {billingError && <Banner tone="danger">{billingError}</Banner>}

      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load your usage. Refresh to try again.</Banner>
      ) : (
        <UsageCard usage={result.usage} />
      )}

      <BillingPanelSection panel={panel} />
    </div>
  );
}

/** Checkout / Portal entry points. Renders nothing at all when billing is off or unconfigured. */
function BillingPanelSection({ panel }: { panel: BillingPanel }) {
  if (panel.kind === "hidden") return null;

  if (panel.kind === "portal") {
    return (
      <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
        <h2 className="text-lg font-semibold tracking-heading text-fg">Billing</h2>
        <p className="text-sm text-fg-secondary">
          Update your payment method, see invoices, or cancel. Cancelling returns you to the free
          tier — and because the free allowance is one-time, capture pauses until you resubscribe.
        </p>
        <form action={openBillingPortalAction}>
          <Button type="submit" variant="secondary">
            Manage billing
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-card border border-hairline bg-surface p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-heading text-fg">Upgrade</h2>
        <p className="text-sm text-fg-secondary">
          Every feature is on every plan — including outbound delivery. Plans differ only by
          included events. You&apos;ll see the price before you pay.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {panel.planIds.map((planId) => (
          <form key={planId} action={startCheckoutAction}>
            <input type="hidden" name="planId" value={planId} />
            <Button type="submit" variant={planId === "pro" ? "primary" : "secondary"}>
              Upgrade to {PLAN_LABEL[planId] ?? planId}
            </Button>
          </form>
        ))}
      </div>

      <p className="text-sm text-fg-secondary">
        Need more than Scale, SSO, or a BAA?{" "}
        <a className="text-fg underline underline-offset-2" href="mailto:sales@webhook.co">
          Talk to us about Enterprise
        </a>
        .
      </p>
    </div>
  );
}

function UsageCard({ usage }: { usage: UsageSummary }) {
  const { events, eventCap, pausePolicy, paused, periodStart, periodEnd, capKind } = usage;
  // The Free tier's ONE-TIME allowance: no periodEnd, never resets — so we must not offer a reset date
  // or tell a paused org to "wait for the next period". The way out is upgrading.
  const lifetime = capKind === "lifetime";
  // The TRUE percentage (uncapped) is shown as text so an over-cap 'allow' org reads its real overage
  // (e.g. 150%) — matching `wbhk usage`. The BAR is a fill gauge, so its width + aria clamp to 100%.
  const pct = eventCap && eventCap > 0 ? Math.round((events / eventCap) * 100) : null;
  const barPct = pct === null ? 0 : Math.min(100, pct);
  // Meter fill tone tracks headroom: comfortable → ok, ≥80% → warn (approaching the cap).
  const meterTone = pct !== null && pct >= 80 ? "bg-warn" : "bg-ok";

  return (
    <div className="flex flex-col gap-5">
      {paused &&
        (lifetime ? (
          <Banner tone="warn">
            Capture is paused — you&apos;ve used your one-time free allowance. It doesn&apos;t
            reset; upgrade to resume capturing.
          </Banner>
        ) : (
          <Banner tone="warn">
            Capture is paused — you&apos;ve reached your event limit for this period. It resumes at
            the start of the next period, or when your limit is raised.
          </Banner>
        ))}

      <div className="flex flex-col gap-6 rounded-card border border-hairline bg-surface p-6">
        <div className="flex items-baseline justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-fg-secondary">
              {lifetime ? "One-time allowance" : "This period"}
            </span>
            <span className="text-sm text-fg">
              {lifetime || periodEnd === null
                ? `Since ${fmtDate(periodStart)} · does not reset`
                : `${fmtDate(periodStart)} — ${fmtDate(periodEnd)}`}
            </span>
          </div>
          <span className={`text-sm ${paused ? "text-warn" : "text-ok"}`}>
            {paused ? "paused" : "active"}
          </span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-heading text-fg">
              {fmtCount(events)}
            </span>
            <span className="text-fg-secondary">
              {eventCap === null ? "events" : `of ${fmtCount(eventCap)} events`}
              {pct !== null ? ` · ${pct}%` : ""}
            </span>
          </div>
          {pct !== null && (
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
              role="progressbar"
              aria-valuenow={barPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Events used this period"
            >
              <div className={`h-full rounded-full ${meterTone}`} style={{ width: `${barPct}%` }} />
            </div>
          )}
        </div>

        <p className="text-sm text-fg-secondary">
          {eventCap === null
            ? "No event limit is set for this org."
            : pausePolicy === "pause"
              ? "At your limit, capture pauses — you're never billed past it."
              : "Events past your included volume are billed as overage."}
        </p>
      </div>
    </div>
  );
}
