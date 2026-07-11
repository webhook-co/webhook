import { Banner, Button } from "@webhook-co/ui";
import { planLabel, type BillingDisplay } from "@webhook-co/shared";
import type { Metadata } from "next";

import { loadBillingSummary } from "@/server/billing";
import {
  cancelSubscriptionAction,
  openBillingPortalAction,
  setOverageAction,
  startCheckoutAction,
  switchPlanAction,
} from "@/server/plan-actions";
import { verifySession } from "@/server/session";

// The dedicated Billing section (WS2). Shows the org's CURRENT plan + status (read from the synced
// subscription mirror, mapped via billingDisplayFromSubscription), the hosted Customer Portal for
// cancel/payment/invoices, and an upgrade/resubscribe picker when the org isn't on an entitled paid plan.
// No price/included-volume figure lives here — Stripe's Checkout shows the amount and /usage shows the cap.

/** A human status line for the current-plan card, honest about grace + cancellation (ADR-0004 / ADR-0020). */
function stateLabel(d: BillingDisplay, when: string): { label: string; tone: "ok" | "warn" } {
  switch (d.state) {
    case "active":
      return { label: `Renews ${when}`, tone: "ok" };
    case "trialing":
      // The shown date is the trial's FIRST charge, not a renewal — say so, or a trial reads as a paid plan.
      return { label: `Trial — first charge ${when}`, tone: "ok" };
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
  already_subscribed:
    "You already have an active subscription — manage or change it below, not by starting a new one.",
  error: "We couldn't reach our payment provider. Nothing was charged — try again.",
  disabled: "Billing isn't available right now.",
};

/** The `?overage=<status>` result banner (setOverageAction redirects here). `ok` confirms the flip; the rest
 *  explain why it didn't apply. */
const OVERAGE_STATUS: Record<string, { message: string; tone: "ok" | "warn" | "danger" }> = {
  ok: { message: "Overage setting updated.", tone: "ok" },
  forbidden: {
    message: "Only an owner or admin can change billing settings.",
    tone: "warn",
  },
  no_subscription: {
    message: "Overage applies once you're on a paid plan.",
    tone: "warn",
  },
  error: { message: "We couldn't update that setting. Please try again.", tone: "danger" },
};

/** The `?switch=<status>` result banner (switchPlanAction redirects here). Covers EVERY SwitchPlanResult
 *  status so no outcome is a silent no-op. */
const SWITCH_STATUS: Record<string, { message: string; tone: "ok" | "warn" | "danger" }> = {
  ok: {
    message:
      "Plan changed. The prorated difference for the rest of this period appears on your next invoice.",
    tone: "ok",
  },
  forbidden: { message: "Only an owner or admin can change the plan.", tone: "warn" },
  no_subscription: {
    message: "You need an active subscription to switch plans. Start one below.",
    tone: "warn",
  },
  same_plan: { message: "You're already on that plan.", tone: "warn" },
  unknown_plan: { message: "That plan isn't available.", tone: "warn" },
  disabled: { message: "Billing isn't available right now.", tone: "warn" },
  error: {
    message: "We couldn't change your plan. Nothing was charged — try again.",
    tone: "danger",
  },
};

/** The `?cancel=<status>` result banner (cancelSubscriptionAction redirects here). Covers EVERY
 *  CancelRefundResult status.
 *
 *  `refund_failed` and `refund_unavailable` must NOT read as a failed cancellation: the subscription IS
 *  cancelled in both, and a user who thinks otherwise would cancel again while we still owe them money.
 *  Equally, `ok` must never promise a refund we didn't actually make — hence the separate statuses. */
const CANCEL_STATUS: Record<string, { message: string; tone: "ok" | "warn" | "danger" }> = {
  ok: {
    message:
      "Subscription cancelled. Any refund for your unused included volume is on its way back to your original payment method.",
    tone: "ok",
  },
  refund_unavailable: {
    message:
      "Your subscription is cancelled. We may owe you a refund but couldn't return it automatically to your original payment method — we've recorded it. Email support@webhook.co and we'll sort it out.",
    tone: "warn",
  },
  refund_failed: {
    message:
      "Your subscription is cancelled, but the refund didn't go through. We've recorded what we owe you — email support@webhook.co and we'll sort it out.",
    tone: "warn",
  },
  forbidden: { message: "Only an owner or admin can cancel the subscription.", tone: "warn" },
  no_subscription: { message: "You don't have an active subscription to cancel.", tone: "warn" },
  disabled: { message: "Billing isn't available right now.", tone: "warn" },
  error: {
    message: "We couldn't cancel your subscription. Nothing changed — try again.",
    tone: "danger",
  },
};

export const metadata: Metadata = { title: "Billing · webhook.co" };

function fmtDate(iso: string): string {
  const t = Date.parse(iso);
  // timeZone:"UTC" — current_period_end is a midnight-UTC instant; without pinning UTC it renders one day
  // early in any behind-UTC runtime (the usage page's fmtDate pins it for the same reason).
  return Number.isNaN(t)
    ? ""
    : new Date(t).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      });
}

function CurrentPlanCard({ display }: { display: BillingDisplay }) {
  const tierLabel = planLabel(display.tier);
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
        Update your payment method or download past invoices.
      </p>
      <form action={openBillingPortalAction}>
        <Button type="submit" variant="secondary">
          Manage payment &amp; invoices
        </Button>
      </form>
    </div>
  );
}

/**
 * Cancel + usage-based refund (slice 2.4). Cancellation lives HERE and not in the hosted Customer Portal on
 * purpose: only this path computes the refund the Terms promise (the unused proportion of the base fee).
 * ⚠️ The Stripe Portal's own "cancel subscription" must stay DISABLED in the Portal configuration — if a
 * customer cancels there, Stripe ends the subscription with no refund and the promise is silently broken.
 */
function CancelSubscriptionCard() {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-lg font-semibold tracking-heading text-fg">Cancel subscription</h2>
      <p className="text-sm text-fg-secondary">
        Cancelling takes effect immediately. We refund the unused part of this period&apos;s plan
        fee based on how little of your included volume you used — not on how many days are left.
        Usage past your included volume is already billed in arrears, so there&apos;s nothing to
        refund there.
      </p>
      <p className="text-sm text-fg-secondary">
        You&apos;ll return to the free tier. The free allowance is one-time, so if you&apos;ve
        already spent it, capture stays paused until you resubscribe.
      </p>
      <form action={cancelSubscriptionAction}>
        <Button type="submit" variant="danger">
          Cancel subscription
        </Button>
      </form>
    </div>
  );
}

function OverageCard({ enabled, canManage }: { enabled: boolean; canManage: boolean }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-heading text-fg">Overage billing</h2>
        <span className={enabled ? "text-sm text-ok" : "text-sm text-fg-secondary"}>
          {enabled ? "On" : "Off"}
        </span>
      </div>
      <p className="text-sm text-fg-secondary">
        {enabled
          ? "Usage past your included volume is billed at the overage rate, so capture keeps running — you won't be paused at your limit."
          : "Capture pauses when you reach your included volume, so you're never billed past it. Turn this on to keep capturing past your limit and pay for the overage."}
      </p>
      {/* Owner/admin only (SEC-RLS-08). A plain member sees the state read-only — not a button the server
          would reject. */}
      {canManage ? (
        <form action={setOverageAction}>
          {/* Submit the OPPOSITE of the current state — the action reads this desired value. */}
          <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
          <Button type="submit" variant="secondary">
            {enabled ? "Turn off overage" : "Turn on overage"}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-fg-secondary">Only an owner or admin can change this.</p>
      )}
    </div>
  );
}

function ChangePlanCard({ targets }: { targets: readonly string[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-lg font-semibold tracking-heading text-fg">Change plan</h2>
      <p className="text-sm text-fg-secondary">
        Switching takes effect immediately. The prorated difference for the rest of this billing
        period — a charge on an upgrade, a credit on a downgrade — appears on your next invoice.
      </p>
      <div className="flex flex-wrap gap-3">
        {targets.map((planId) => (
          <form key={planId} action={switchPlanAction}>
            <input type="hidden" name="planId" value={planId} />
            {/* Per-render nonce → the Stripe Idempotency-Key: a double-click of THIS button collapses to
                one charge, while a fresh render (a later, deliberate switch) gets a new nonce. */}
            <input type="hidden" name="nonce" value={crypto.randomUUID()} />
            <Button type="submit" variant="secondary">
              Switch to {planLabel(planId)}
            </Button>
          </form>
        ))}
      </div>
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
              {resubscribe ? "Resubscribe to" : "Start on"} {planLabel(planId)}
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
  const { orgId, userId } = await verifySession();
  const [view, params] = await Promise.all([loadBillingSummary(orgId, userId), searchParams]);
  const errorKey = typeof params.billing === "string" ? params.billing : undefined;
  // hasOwn, not a bare index: `?billing=toString` (untrusted query) would otherwise resolve to a
  // prototype method and React would throw trying to render it.
  const errorMsg =
    errorKey && Object.hasOwn(BILLING_ERROR, errorKey) ? BILLING_ERROR[errorKey] : undefined;
  const overageKey = typeof params.overage === "string" ? params.overage : undefined;
  const overageStatus =
    overageKey && Object.hasOwn(OVERAGE_STATUS, overageKey)
      ? OVERAGE_STATUS[overageKey]
      : undefined;
  const switchKey = typeof params.switch === "string" ? params.switch : undefined;
  const switchStatus =
    switchKey && Object.hasOwn(SWITCH_STATUS, switchKey) ? SWITCH_STATUS[switchKey] : undefined;
  const cancelKey = typeof params.cancel === "string" ? params.cancel : undefined;
  const cancelStatus =
    cancelKey && Object.hasOwn(CANCEL_STATUS, cancelKey) ? CANCEL_STATUS[cancelKey] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-display text-fg">Billing</h1>
        <p className="mt-1 text-sm text-fg-secondary">Your plan, payment, and invoices.</p>
      </div>

      {errorMsg && <Banner tone="danger">{errorMsg}</Banner>}
      {overageStatus && <Banner tone={overageStatus.tone}>{overageStatus.message}</Banner>}
      {switchStatus && <Banner tone={switchStatus.tone}>{switchStatus.message}</Banner>}
      {cancelStatus && <Banner tone={cancelStatus.tone}>{cancelStatus.message}</Banner>}

      {view.hidden ? (
        <div className="rounded-card border border-hairline bg-surface p-6">
          <p className="text-sm text-fg-secondary">Billing isn&apos;t available right now.</p>
        </div>
      ) : (
        <>
          {view.display && <CurrentPlanCard display={view.display} />}
          {/* Owner/admin only — plan switching is a billing change (SEC-RLS-08); the server re-checks. */}
          {view.canManageBilling && view.switchTargets.length > 0 && (
            <ChangePlanCard targets={view.switchTargets} />
          )}
          {view.overageEnabled !== null && (
            <OverageCard enabled={view.overageEnabled} canManage={view.canManageBilling} />
          )}
          {view.upgradePlanIds.length > 0 && (
            <UpgradeCard planIds={view.upgradePlanIds} resubscribe={view.display !== null} />
          )}
          {view.hasCustomer && <ManageBillingCard />}
          {/* Owner/admin only, and only while there's something live to cancel — a sub already canceled or
              dropped to the free allowance has nothing to end and nothing to refund. The server re-checks
              both (SEC-RLS-08 + a live-Stripe status read), so this is presentation, not the gate. */}
          {view.canManageBilling &&
            view.display &&
            view.display.state !== "canceled" &&
            view.display.state !== "inactive" && <CancelSubscriptionCard />}
          {/* A live subscription whose Stripe customer hasn't mirrored yet (the two setup webhooks can
              land out of order): no picker (it would double-subscribe) and no Portal (we have no customer
              id to open one) — so give the user context instead of an actionless card. Transient. */}
          {view.display && !view.hasCustomer && view.upgradePlanIds.length === 0 && (
            <div className="rounded-card border border-hairline bg-surface p-6">
              <p className="text-sm text-fg-secondary">
                We&apos;re finishing setting up your billing details. Refresh in a moment to manage
                your payment method and invoices.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
