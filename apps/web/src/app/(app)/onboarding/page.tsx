import { AuthShell, ThemeToggle } from "@webhook-co/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OnboardingForm } from "@/components/onboarding-form";
import { completeOnboardingAction } from "@/server/onboarding-actions";
import { resolveOnboarding } from "@/server/onboarding";

export const metadata: Metadata = {
  title: "Welcome · webhook.co",
};

/**
 * The onboarding screen — shown once, right after a first signup.
 *
 * It RE-RESOLVES the gate rather than trusting the redirect that sent the user here. Someone who has already
 * onboarded (or who typed `/onboarding` directly) is sent straight back to `/`, so this page cannot be used to
 * re-run onboarding or to sit in a state the gate says is finished.
 *
 */
// dal-gate-allow: user-scoped — resolveOnboarding gates on verifySession; no org data (no org in this URL).
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [decision, sp] = await Promise.all([resolveOnboarding(), searchParams]);
  // Carry a whitelisted invite-status flag through onboarding so a brand-new invitee's confirmation survives
  // (see `/`'s comment). Only known values; never an open passthrough.
  const rawInvite = typeof sp.invite === "string" ? sp.invite : undefined;
  const invite =
    rawInvite && ["accepted", "invalid", "error"].includes(rawInvite) ? rawInvite : undefined;

  // Already onboarded / typed the URL directly → back to `/`, preserving the flag so it is not dropped here.
  if (!decision.show) redirect(invite ? `/?invite=${invite}` : "/");

  return (
    <AuthShell homeHref="/" actions={<ThemeToggle />}>
      <OnboardingForm
        firstName={decision.firstName}
        lastName={decision.lastName}
        needsOrgName={decision.needsOrgName}
        defaultOrgName={decision.org?.name ?? ""}
        invite={invite}
        complete={completeOnboardingAction}
      />
    </AuthShell>
  );
}
