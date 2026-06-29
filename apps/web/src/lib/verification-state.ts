import type { VerificationState } from "@webhook-co/shared";

// Pure, client-safe mapping for the events-list verification tri-state. `failed` (an adapter ran and
// rejected the signature) is the only state shown as a danger/red — `unattempted` (no signature was
// checked: no secret, header absent, or a rare KMS/internal error, all collapsed to one bucket) stays
// neutral so an unsigned event never alarms, and an unknown/absent state degrades to neutral too.

// The verification-state vocabulary, shown in the filter dropdown. A deliberate client-safe MIRROR of
// `@webhook-co/shared`'s VERIFICATION_STATES — kept local so this client-bundled module doesn't pull the
// shared barrel into the browser bundle. The contract enum (VerificationStateSchema) is the source of
// truth; the contract + filter tests catch any drift.
export const VERIFICATION_STATES = ["verified", "failed", "unattempted"] as const;

/** Human label for a verification state (the single source for both the filter dropdown + the pill). */
export const VERIFICATION_STATE_LABELS: Record<VerificationState, string> = {
  verified: "Verified",
  failed: "Failed",
  unattempted: "Not verified",
};

const PILL_TONE: Record<VerificationState, "ok" | "danger" | "neutral"> = {
  verified: "ok",
  failed: "danger", // ONLY a genuine signature failure goes red
  unattempted: "neutral",
};

/**
 * The list-row pill tone + label for an event. Prefers the derived `verificationState`; falls back to
 * the always-present `verified` boolean if the state is absent (version skew / a non-listEvents source)
 * so a verified event still reads green rather than being silently downgraded to neutral. An absent
 * state on an UNverified event can't distinguish failed from unattempted → neutral "Not verified".
 */
export function verificationStatePill(
  state: VerificationState | undefined,
  verified?: boolean,
): { tone: "ok" | "danger" | "neutral"; label: string } {
  const effective: VerificationState = state ?? (verified ? "verified" : "unattempted");
  return { tone: PILL_TONE[effective], label: VERIFICATION_STATE_LABELS[effective] };
}
