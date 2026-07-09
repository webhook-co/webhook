"use server";

import { redirect } from "next/navigation";

import { openBillingPortal, startCheckout } from "./billing";
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

const USAGE = "/usage";

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
  redirect(`${USAGE}?billing=${result.status}`);
}

/** Open the hosted Customer Portal (manage payment method / cancel). Requires an existing Stripe customer. */
export async function openBillingPortalAction(): Promise<void> {
  const session = await verifySession();
  const result = await openBillingPortal(session.orgId);
  if (result.status === "ok") redirect(result.url);
  redirect(`${USAGE}?billing=${result.status}`);
}
