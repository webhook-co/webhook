import "server-only";

import { readUserOrgDirectory } from "./org-directory";
import { decideOnboarding, type OnboardingDecision } from "./onboarding-logic";
import { getOnboardingBinding } from "./env";
import { logActionError } from "./action-log";
import { verifySession } from "./session";

// dal-gate-allow: user-scoped onboarding read — gates on verifySession; the identity read is over the auth.
// binding (keyed by the verified userId), the org read is the user's own directory. No org to prove.

/**
 * Should the signed-in user see onboarding, and pre-filled with what?
 *
 * Reads two things — the identity state (over auth.'s OnboardingProfile binding, because `onboardedAt` lives
 * on the identity realm) and the user's org directory — then defers the actual decision to the PURE
 * {@link decideOnboarding}, which is where the fresh-vs-invited logic is tested.
 *
 * Fails OPEN, deliberately. If the binding is unbound (dev / pre-provision) or the read throws, we return
 * "don't show" rather than trapping the user in an onboarding screen they cannot get past. Onboarding is a
 * nicety; never letting someone reach their dashboard is a failure.
 */
export async function resolveOnboarding(): Promise<OnboardingDecision> {
  const session = await verifySession();

  const binding = getOnboardingBinding();
  if (!binding) return { show: false };

  let state;
  try {
    state = await binding.read(session.userId);
  } catch (error) {
    logActionError("onboarding.read_failed", error);
    return { show: false };
  }

  const orgs = await readUserOrgDirectory(session.userId);
  return decideOnboarding({ userId: session.userId, state, orgs });
}
