import { Banner, Button, PageContainer, PageHeader, PlanCard } from "@webhook-co/ui";
import { planLabel, type BillingDisplay, type PendingPlanChange } from "@webhook-co/shared";
import { planById } from "@webhook-co/shared/plans";
import type { Metadata } from "next";

import { loadBillingSummary } from "@/server/billing";
import {
  cancelDowngradeAction,
  openBillingPortalAction,
  setOverageAction,
  startCheckoutAction,
  switchPlanAction,
} from "@/server/plan-actions";
import { requireOrgAccess } from "@/server/org-access";

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
  forbidden: "Only an owner or admin can manage billing.",
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
      "Upgraded. Your new volume is available right now, and the prorated difference for the rest of this period appears on your next invoice.",
    tone: "ok",
  },
  scheduled: {
    message:
      "Downgrade scheduled. You keep your current plan until the end of this billing period, then move to the smaller one — nothing is charged or refunded in the meantime.",
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

/** The `?downgrade=<status>` banner (cancelDowngradeAction redirects here) — the UNDO of a booked downgrade. */
const DOWNGRADE_STATUS: Record<string, { message: string; tone: "ok" | "warn" | "danger" }> = {
  ok: {
    message: "Downgrade cancelled. You'll stay on your current plan and renew as normal.",
    tone: "ok",
  },
  nothing_pending: { message: "You don't have a downgrade scheduled.", tone: "warn" },
  forbidden: { message: "Only an owner or admin can change the plan.", tone: "warn" },
  no_subscription: { message: "You don't have an active subscription.", tone: "warn" },
  disabled: { message: "Billing isn't available right now.", tone: "warn" },
  error: {
    message: "We couldn't cancel the downgrade. Nothing changed — try again.",
    tone: "danger",
  },
};

export const metadata: Metadata = { title: "Billing · webhook.co" };

/** Format a Unix-SECONDS instant as a date (UTC-pinned, like the other dates on this page). */
function fmtUnix(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A downgrade already booked for the end of the period (ADR-0112). Shown on EVERY visit, not just in the
 * banner at the instant it was scheduled — otherwise a user who books one and comes back tomorrow has no way
 * to know it is coming, and no way to undo it.
 */
function PendingDowngradeCard({
  slug,
  pending,
  canManage,
}: {
  slug: string;
  pending: PendingPlanChange;
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-lg font-semibold tracking-heading text-fg">Scheduled plan change</h2>
      <p className="font-medium text-fg">
        You move to {planLabel(pending.plan)} on {fmtUnix(pending.effectiveAt)}.
      </p>
      <p className="text-fg-secondary">
        Nothing changes before then — you keep your current plan for the rest of the period
        you&apos;ve paid for, and nothing is charged or refunded in the meantime.
      </p>
      {canManage ? (
        <form action={cancelDowngradeAction.bind(null, slug)}>
          <Button type="submit" variant="secondary">
            Cancel this change &amp; keep my plan
          </Button>
        </form>
      ) : (
        <p className="text-fg-secondary">Only an owner or admin can change this.</p>
      )}
    </div>
  );
}

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

function CurrentPlanCard({ slug, display }: { slug: string; display: BillingDisplay }) {
  const tierLabel = planLabel(display.tier);
  const status = stateLabel(display, fmtDate(display.periodEnd));
  return (
    <div className="flex flex-col gap-4 rounded-card border border-hairline bg-surface p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-heading text-fg">Current plan</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tracking-heading text-fg">{tierLabel}</span>
        </div>
        <p className={status.tone === "warn" ? "font-medium text-fg" : "text-fg-secondary"}>
          {status.label}
        </p>
      </div>
      <p className="text-fg-secondary">
        See your included volume and current usage on the{" "}
        <a className="text-fg underline underline-offset-2" href={`/org/${slug}/usage`}>
          Usage
        </a>{" "}
        page.
      </p>
    </div>
  );
}

function ManageBillingCard({ slug, canManage }: { slug: string; canManage: boolean }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-lg font-semibold tracking-heading text-fg">Payment &amp; invoices</h2>
      <p className="text-fg-secondary">
        Update your payment method, download invoices, or cancel your plan. Cancelling returns you
        to the free tier — and because the free allowance is one-time, capture pauses until you
        resubscribe.
      </p>
      {/* The Portal is owner/admin only, and the server now enforces it. Show a plain member the state and
          say who can act, rather than a button whose only possible outcome is an error (the same
          show-and-explain shape OverageCard uses). */}
      {canManage ? (
        <form action={openBillingPortalAction.bind(null, slug)}>
          <Button type="submit" variant="secondary">
            Manage payment &amp; invoices
          </Button>
        </form>
      ) : (
        <p className="text-fg-secondary">Only an owner or admin can manage payment and invoices.</p>
      )}
    </div>
  );
}

function OverageCard({
  slug,
  enabled,
  canManage,
}: {
  slug: string;
  enabled: boolean;
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-heading text-fg">Overage billing</h2>
        <span className={enabled ? "text-sm text-ok" : "text-sm text-fg-secondary"}>
          {enabled ? "On" : "Off"}
        </span>
      </div>
      <p className="text-fg-secondary">
        {enabled
          ? "Usage past your included volume is billed at the overage rate, so capture keeps running — you won't be paused at your limit."
          : "Capture pauses when you reach your included volume, so you're never billed past it. Turn this on to keep capturing past your limit and pay for the overage."}
      </p>
      {/* Owner/admin only (SEC-RLS-08). A plain member sees the state read-only — not a button the server
          would reject. */}
      {canManage ? (
        <form action={setOverageAction.bind(null, slug)}>
          {/* Submit the OPPOSITE of the current state — the action reads this desired value. */}
          <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
          <Button type="submit" variant="secondary">
            {enabled ? "Turn off overage" : "Turn on overage"}
          </Button>
        </form>
      ) : (
        <p className="text-fg-secondary">Only an owner or admin can change this.</p>
      )}
    </div>
  );
}

function ChangePlanCard({ slug, targets }: { slug: string; targets: readonly string[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-6">
      <h2 className="text-lg font-semibold tracking-heading text-fg">Change plan</h2>
      <p className="text-fg-secondary">
        <strong className="text-fg">Upgrades take effect immediately</strong> — you get the extra
        volume right away, and the prorated difference for the rest of this period appears on your
        next invoice.{" "}
        <strong className="text-fg">
          Downgrades take effect at the end of this billing period
        </strong>
        : you keep the plan you&apos;ve paid for until it runs out, then move to the smaller one. We
        don&apos;t refund or credit the part you&apos;ve already paid for.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {targets.map((planId) => {
          const plan = planById(planId);
          if (!plan) return null;
          return (
            <PlanCard
              key={planId}
              plan={plan}
              cta={
                <form action={switchPlanAction.bind(null, slug)}>
                  <input type="hidden" name="planId" value={planId} />
                  {/* Per-render nonce → the Stripe Idempotency-Key: a double-click of THIS button collapses
                      to one charge, while a fresh render (a later, deliberate switch) gets a new nonce. */}
                  <input type="hidden" name="nonce" value={crypto.randomUUID()} />
                  <Button type="submit" variant="secondary" className="w-full">
                    Switch to {plan.name}
                  </Button>
                </form>
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function UpgradeCard({
  slug,
  planIds,
  resubscribe,
  canManage,
}: {
  slug: string;
  planIds: readonly string[];
  resubscribe: boolean;
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-hairline bg-surface p-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold tracking-heading text-fg">
          {resubscribe ? "Resubscribe" : "Choose a plan"}
        </h2>
        <p className="text-fg-secondary">
          Every feature is on every plan — including outbound delivery. Plans differ only by
          included events. You&apos;ll see the price before you pay.
        </p>
      </div>
      {/* Starting a subscription commits the org to a charge — owner/admin only, and the server enforces it.
          A plain member still sees what the plans are; they just can't be the one to buy. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {planIds.map((planId) => {
          const plan = planById(planId);
          if (!plan) return null;
          return (
            <PlanCard
              key={planId}
              plan={plan}
              // A member sees the plan and its figures, just not a buy button — they lose the control, not
              // the information. Starting a subscription commits the org to a charge (owner/admin only; the
              // server re-enforces it).
              cta={
                canManage ? (
                  <form action={startCheckoutAction.bind(null, slug)}>
                    <input type="hidden" name="planId" value={planId} />
                    <Button
                      type="submit"
                      variant={planId === "pro" ? "primary" : "secondary"}
                      className="w-full"
                    >
                      {resubscribe ? "Resubscribe to" : "Start on"} {plan.name}
                    </Button>
                  </form>
                ) : undefined
              }
            />
          );
        })}
      </div>
      {!canManage && (
        <p className="text-fg-secondary">Only an owner or admin can start or change a plan.</p>
      )}
      <p className="text-fg-secondary">
        Need more than Scale?{" "}
        <a className="text-fg underline underline-offset-2" href="mailto:sales@webhook.co">
          Talk to us about Enterprise
        </a>
        .
      </p>
    </div>
  );
}

export default async function BillingPage({
  params: routeParams,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await routeParams;
  // subPath: a mis-cased or retired slug 308s to the canonical URL with this deep link intact.
  const { orgId, userId, slug: orgSlug } = await requireOrgAccess(slug, "/billing");
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
  const downgradeKey = typeof params.downgrade === "string" ? params.downgrade : undefined;
  const downgradeStatus =
    downgradeKey && Object.hasOwn(DOWNGRADE_STATUS, downgradeKey)
      ? DOWNGRADE_STATUS[downgradeKey]
      : undefined;

  return (
    <PageContainer gap="gap-6">
      <PageHeader title="Billing" description="Your plan, payment, and invoices." />

      {errorMsg && <Banner tone="danger">{errorMsg}</Banner>}
      {overageStatus && <Banner tone={overageStatus.tone}>{overageStatus.message}</Banner>}
      {switchStatus && <Banner tone={switchStatus.tone}>{switchStatus.message}</Banner>}
      {downgradeStatus && <Banner tone={downgradeStatus.tone}>{downgradeStatus.message}</Banner>}

      {view.hidden ? (
        <div className="rounded-card border border-hairline bg-surface p-6">
          <p className="text-fg-secondary">Billing isn&apos;t available right now.</p>
        </div>
      ) : (
        <>
          {view.display && <CurrentPlanCard slug={orgSlug} display={view.display} />}
          {/* A booked downgrade, shown on EVERY visit — with the undo. Without this the user schedules one,
              comes back tomorrow, and has no way to see it coming or call it off. */}
          {view.pendingDowngrade && (
            <PendingDowngradeCard
              slug={orgSlug}
              pending={view.pendingDowngrade}
              canManage={view.canManageBilling}
            />
          )}
          {/* Owner/admin only — plan switching is a billing change (SEC-RLS-08); the server re-checks. */}
          {view.canManageBilling && view.switchTargets.length > 0 && (
            <ChangePlanCard slug={orgSlug} targets={view.switchTargets} />
          )}
          {view.overageEnabled !== null && (
            <OverageCard
              slug={orgSlug}
              enabled={view.overageEnabled}
              canManage={view.canManageBilling}
            />
          )}
          {view.upgradePlanIds.length > 0 && (
            <UpgradeCard
              slug={orgSlug}
              planIds={view.upgradePlanIds}
              resubscribe={view.display !== null}
              canManage={view.canManageBilling}
            />
          )}
          {view.hasCustomer && (
            <ManageBillingCard slug={orgSlug} canManage={view.canManageBilling} />
          )}
          {/* A live subscription whose Stripe customer hasn't mirrored yet (the two setup webhooks can
              land out of order): no picker (it would double-subscribe) and no Portal (we have no customer
              id to open one) — so give the user context instead of an actionless card. Transient. */}
          {view.display && !view.hasCustomer && view.upgradePlanIds.length === 0 && (
            <div className="rounded-card border border-hairline bg-surface p-6">
              <p className="text-fg-secondary">
                We&apos;re finishing setting up your billing details. Refresh in a moment to manage
                your payment method and invoices.
              </p>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
