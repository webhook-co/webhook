// The auth-side of the web→auth onboarding RPC. Only apps/auth (webhook_auth via HYPERDRIVE_AUTH) may touch
// the global identity realm (`user`), so apps/web — which verifies the session and passes its OWN
// authenticated userId — RPCs the OnboardingProfile WorkerEntrypoint (worker.ts), which delegates here.
//
// This is the SAME boundary account-deletion crosses (account-delete-deps): identity is written from
// webhook_auth's own process, never by webhook_app, and never by a SECURITY DEFINER writer. Kept a thin,
// type-checked module (worker.ts itself is tsc-excluded), mirroring session-exchange-deps / account-delete-deps.
//
// AUTHZ: the caller has already verified the session; the binding is worker-to-worker (not public); the userId
// is the caller's own. So a user can only ever read/complete their OWN onboarding.

import { completeOnboarding, createClient, readOnboardingState } from "@webhook-co/db";

/** The minimal env the onboarding RPC needs: the webhook_auth Hyperdrive over the identity realm. */
export interface OnboardingEnv {
  readonly HYPERDRIVE_AUTH: { readonly connectionString: string };
}

/** The onboarding-relevant identity slice, serialised for the RPC (Dates as ISO strings over the boundary). */
export interface OnboardingStateDto {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly name: string;
  readonly onboardedAtIso: string | null;
  readonly createdAtIso: string;
}

/** Read a user's onboarding state as webhook_auth. Null if no such user. Short-lived pool, closed in finally. */
export async function readOnboardingRpc(
  env: OnboardingEnv,
  userId: string,
): Promise<OnboardingStateDto | null> {
  const authClient = createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 1 });
  try {
    const state = await readOnboardingState(authClient, userId);
    if (!state) return null;
    return {
      firstName: state.firstName,
      lastName: state.lastName,
      name: state.name,
      // Serialise Dates for the worker-to-worker hop; the web side parses back.
      onboardedAtIso: state.onboardedAt ? state.onboardedAt.toISOString() : null,
      createdAtIso: state.createdAt.toISOString(),
    };
  } finally {
    await authClient.end();
  }
}

export interface CompleteOnboardingResult {
  /** False if the user row was already gone (idempotent / raced with a delete). */
  readonly completed: boolean;
}

/**
 * Persist the onboarding profile + stamp onboardedAt, as webhook_auth. The timestamp is generated HERE (on
 * the identity side that owns the write) rather than taken from the caller, so the gate cannot be tricked into
 * an already-onboarded state with a client-supplied time.
 */
export async function completeOnboardingRpc(
  env: OnboardingEnv,
  input: { userId: string; firstName: string; lastName: string },
): Promise<CompleteOnboardingResult> {
  const authClient = createClient(env.HYPERDRIVE_AUTH.connectionString, { max: 1 });
  try {
    const completed = await completeOnboarding(authClient, {
      userId: input.userId,
      firstName: input.firstName,
      lastName: input.lastName,
      onboardedAt: new Date(),
    });
    return { completed };
  } finally {
    await authClient.end();
  }
}
