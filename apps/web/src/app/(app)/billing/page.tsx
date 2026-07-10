import { Banner, Button } from "@webhook-co/ui";
import type { BillingDisplay } from "@webhook-co/shared";
import type { Metadata } from "next";

import { loadBillingSummary } from "@/server/billing";
import { openBillingPortalAction, startCheckoutAction } from "@/server/plan-actions";
import { verifySession } from "@/server/session";

// The dedicated Billing section (WS2). Shows the org's CURRENT plan + status (read from the synced
// subscription mirror, mapped via billingDisplayFromSubscription), the hosted Customer Portal for
// cancel/payment/invoices, and an upgrade/resubscribe picker when the org isn't on an entitled paid plan.
// No price/included-volume figure lives here — Stripe's Checkout shows the amount and /usage shows the cap.

const PLAN_LABEL: Record<string, string> = { pro: "Pro", scale: "Scale" };

/** A human status line for the current-plan card, honest about grace + cancellation (ADR-0004 / ADR-0020). */
function stateLabel(d: BillingDisplay, when: string): { label: string; tone: "ok" | "warn" } {
  switch (d.state) {
    case "active":
      return { label: `Renews ${when}`, tone: "ok" };
    case "canceling":
      return {
        label: `Cancels ${when} — capture pauses then, until you resubscribe`,
        tone: "warn",
      };
    case "past_due":
      return {
        label: "Payment past due — we're retrying your card (your plan stays active)",
        tone: "warn",
      };
    case "canceled":
      return { label: "Canceled — you're back on the free allowance", tone: "warn" };
    case "inactive":
      return { label: "Inactive — your subscription isn't active", tone: "warn" };
  }
}

const BILLING_ERROR: Record<string, string> = {
  unknown_plan: "That plan isn't available. Pick one below, or contact us about Enterprise.",
  no_customer: "You don't have a subscription to manage yet.",
  error: "We couldn't reach our payment provider. Nothing was charged — try again.",
  disabled: "Billing isn't available right now.",
};

export const metadata: Metadata = { title: "Billing · webhook.co" };

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? ""
    : new Date(t).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function CurrentPlanCard({ display }: { display: BillingDisplay }) {
  const tierLabel =
    display.tier === "unknown" ? "Paid plan" : (PLAN_LABEL[display.tier] ?? "Paid plan");
  const status = stateLabel(display, fmtDate(display.periodEnd));
  return (
    <div className="flex flex-col gap-4 rounded-card border border-hairline bg-surface p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-heading text-fg">Current plan</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tracking-heading text-fg">{tierLabel}</span>
        </div>
        <p
          className={
            status.tone === "warn" ? "text-sm font-medium text-fg" : "text-sm text-fg-secondary"
          }
        >
          {status.label}
        </p>
      </div>
      <p className="text-sm text-fg-secondary">
        See your included volume and current usage on the{" "}
        <a className="text-fg underline underline-offset-2" href="/usage">
          Usage
        </a>{" "}
        page.
      </p>
    </div>
  );
}

function ManageBillingCard() {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-lg font-semibold tracking-heading text-fg">Payment &amp; invoices</h2>
      <p className="text-sm text-fg-secondary">
        Update your payment method, download invoices, or cancel your plan. Cancelling returns you
        to the free tier — and because the free allowance is one-time, capture pauses until you
        resubscribe.
      </p>
      <form action={openBillingPortalAction}>
        <Button type="submit" variant="secondary">
          Manage payment &amp; invoices
        </Button>
      </form>
    </div>
  );
}

function UpgradeCard({
  planIds,
  resubscribe,
}: {
  planIds: readonly string[];
  resubscribe: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-hairline bg-surface p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-heading text-fg">
          {resubscribe ? "Resubscribe" : "Choose a plan"}
        </h2>
        <p className="text-sm text-fg-secondary">
          Every feature is on every plan — including outbound delivery. Plans differ only by
          included events. You&apos;ll see the price before you pay.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        {planIds.map((planId) => (
          <form key={planId} action={startCheckoutAction}>
            <input type="hidden" name="planId" value={planId} />
            <Button type="submit" variant={planId === "pro" ? "primary" : "secondary"}>
              {resubscribe ? "Resubscribe to" : "Start on"} {PLAN_LABEL[planId] ?? planId}
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

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { orgId } = await verifySession();
  const [view, params] = await Promise.all([loadBillingSummary(orgId), searchParams]);
  const errorKey = typeof params.billing === "string" ? params.billing : undefined;
  // hasOwn, not a bare index: `?billing=toString` (untrusted query) would otherwise resolve to a
  // prototype method and React would throw trying to render it.
  const errorMsg =
    errorKey && Object.hasOwn(BILLING_ERROR, errorKey) ? BILLING_ERROR[errorKey] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-display text-fg">Billing</h1>
        <p className="mt-1 text-sm text-fg-secondary">Your plan, payment, and invoices.</p>
      </div>

      {errorMsg && <Banner tone="danger">{errorMsg}</Banner>}

      {view.hidden ? (
        <div className="rounded-card border border-hairline bg-surface p-6">
          <p className="text-sm text-fg-secondary">Billing isn&apos;t available right now.</p>
        </div>
      ) : (
        <>
          {view.display && <CurrentPlanCard display={view.display} />}
          {view.upgradePlanIds.length > 0 && (
            <UpgradeCard planIds={view.upgradePlanIds} resubscribe={view.display !== null} />
          )}
          {view.hasCustomer && <ManageBillingCard />}
        </>
      )}
    </div>
  );
}
