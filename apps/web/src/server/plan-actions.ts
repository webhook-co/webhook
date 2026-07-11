"use server";

import { redirect } from "next/navigation";

import { openBillingPortal, startCheckout } from "./billing";
import { applyOverageToggle } from "./overage";
import { switchPlan } from "./plan-switch";
import { verifySession } from "./session";

// Server actions behind the dashboard billing panel. Both hand off to a Stripe-HOSTED page (Checkout or the
// Customer Portal), so we never touch a card, an amount, or a payment method — that stays out of PCI scope.
//
// Neither action ever throws: startCheckout/openBillingPortal already fold a Stripe or DB fault into a result
// state, and we turn that into a `?billing=` query flag the usage page renders as a banner. A server action
// that rejects would surface as an unhandled 500 on a page the user reached by clicking "Upgrade".
//
// `redirect()` works by throwing a control-flow signal that Next catches, so it MUST be called outside any
// try/catch — otherwise the redirect is swallowed and reported as an error.

const BILLING = "/billing";

/** Start hosted Checkout for `planId` (untrusted form input; startCheckout gates it before any Stripe call). */
export async function startCheckoutAction(formData: FormData): Promise<void> {
  const planId = formData.get("planId");
  const session = await verifySession();
  const result =
    typeof planId === "string"
      ? await startCheckout(session.orgId, planId, session.user.email)
      : ({ status: "unknown_plan" } as const);

  // Outside any try/catch — see above.
  if (result.status === "ok") redirect(result.url);
  redirect(`${BILLING}?billing=${result.status}`);
}

/** Open the hosted Customer Portal (manage payment method / cancel). Requires an existing Stripe customer. */
export async function openBillingPortalAction(): Promise<void> {
  const session = await verifySession();
  const result = await openBillingPortal(session.orgId);
  if (result.status === "ok") redirect(result.url);
  redirect(`${BILLING}?billing=${result.status}`);
}

/**
 * Toggle overage billing on/off (WS3). The desired state rides a hidden `enabled` field ("true"/"false") — the
 * form submits the OPPOSITE of the current state. applyOverageToggle never throws (folds faults into a status),
 * gates owner/admin + audits in the DB, and reconciles enforcement via the engine. Lands back on /billing.
 */
export async function setOverageAction(formData: FormData): Promise<void> {
  const enabled = formData.get("enabled") === "true";
  const session = await verifySession();
  const result = await applyOverageToggle(session.orgId, session.userId, enabled);
  redirect(`${BILLING}?overage=${result.status}`);
}

/**
 * Switch the subscription to `planId` (WS4). switchPlan never throws (folds faults into a status), gates
 * owner/admin, validates the target, and calls Stripe with immediate proration. `planId` is untrusted form
 * input — switchPlan gates it before any Stripe call. Lands back on /billing.
 */
export async function switchPlanAction(formData: FormData): Promise<void> {
  const planId = formData.get("planId");
  // A per-form-render nonce (ChangePlanCard) → the Stripe Idempotency-Key, so a double-submit collapses to
  // one charge. A string or nothing; switchPlan simply forwards it.
  const nonce = formData.get("nonce");
  const session = await verifySession();
  const result =
    typeof planId === "string"
      ? await switchPlan(
          session.orgId,
          session.userId,
          planId,
          typeof nonce === "string" ? nonce : undefined,
        )
      : ({ status: "unknown_plan" } as const);
  redirect(`${BILLING}?switch=${result.status}`);
}
