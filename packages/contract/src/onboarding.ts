// The frozen auth.↔web onboarding contract. First/last name and `onboardedAt` live on the global identity
// `user` row, which only auth. (webhook_auth) may write, so the web dashboard reads the onboarding state and
// completes onboarding over a service-binding entrypoint (OnboardingProfile) rather than touching `user`.
//
// This is ONE definition both apps type against, so the wire shape can't drift across the worker boundary: a
// field added on one side but not the other would otherwise compile cleanly and silently mismatch at runtime.

/** The onboarding-relevant identity slice, serialised for the RPC (Dates as ISO strings over the boundary). */
export interface OnboardingStateDto {
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** Better Auth's composite display name — the fallback the web side splits when there is no given/family. */
  readonly name: string;
  /** ISO string, or null for a user who has not finished onboarding. */
  readonly onboardedAtIso: string | null;
  /** ISO string — the signup time, used as the "predates the feature" backstop for the gate. */
  readonly createdAtIso: string;
}

/** The result of completing onboarding. */
export interface CompleteOnboardingResult {
  /** False if the user row was already gone (idempotent / raced with a delete). */
  readonly completed: boolean;
}

/** The result of a display-name edit. */
export interface UpdateNameResult {
  /** False if the user row was gone, or the name was empty (a NOT-NULL name is never blanked). */
  readonly updated: boolean;
}

/** The result of pointing (or clearing) a user's uploaded-avatar R2 key. */
export interface UpdateImageKeyResult {
  /** False if the user row was gone. */
  readonly updated: boolean;
}

/**
 * The onboarding RPC seam — a Cloudflare service-binding entrypoint on auth. (OnboardingProfile). The web
 * dashboard types its `env.AUTH_ONBOARDING` against this so the cross-Worker call site is contract-checked.
 * The caller passes the SERVER-verified userId (from its own session — never client-supplied), and the
 * `onboardedAt` timestamp is minted auth-side, so a user can only ever read/complete their OWN onboarding and
 * cannot supply a time that flips the gate.
 */
export interface OnboardingProfileService {
  /** Read a user's onboarding state; null if no such user. */
  read(userId: string): Promise<OnboardingStateDto | null>;
  /** Persist the profile name and stamp `onboardedAt` (minted auth-side). */
  complete(userId: string, firstName: string, lastName: string): Promise<CompleteOnboardingResult>;
  /**
   * Edit just the display name (the composite `user.name` the app renders). Does NOT touch `onboardedAt` — an
   * already-onboarded user editing their name must not re-flip the gate. The caller passes its OWN verified
   * userId; the name is validated/trimmed and a NOT-NULL name is never blanked.
   */
  updateName(userId: string, name: string): Promise<UpdateNameResult>;
  /**
   * Point the user's avatar at an uploaded R2 object key (or clear it with null). The caller passes its OWN
   * verified userId; the route handler has already validated + stored the image. `imageKey` is app-written
   * only (never client-settable) — this RPC is the single write path.
   */
  updateImageKey(userId: string, imageKey: string | null): Promise<UpdateImageKeyResult>;
}
