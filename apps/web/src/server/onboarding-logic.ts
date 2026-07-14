import "server-only";

import { personalOrgId, type UserOrg } from "@webhook-co/db/orgs";

import type { OnboardingStateDto } from "./env";

/**
 * The onboarding decision, as a PURE function of state the caller has already fetched — so every branch
 * (shown / skipped / invited / fresh) is testable without a database or an RPC.
 *
 * Two questions, decided here:
 *
 *   1. **Do we show onboarding at all?** Only when `onboardedAt` is null. After migration 0074 grandfathered
 *      every existing user, a null means precisely "a new signup that has not finished onboarding" — so this
 *      is a clean boolean, not a heuristic about org names.
 *
 *   2. **Does this user name an org?** Only a FRESH signup does. A user who arrived via an INVITE already
 *      belongs to a real, already-named org (the one they were invited to) and must not be asked to name
 *      anything — asking would be nonsense, and it would tempt them into renaming a team that is not theirs to
 *      rename. We detect "invited" structurally: they hold a membership in some org OTHER than their own
 *      derived personal org. A fresh signup's only membership is that personal org, still bearing its
 *      machine-generated name — that is the one onboarding offers to rename.
 */
export type OnboardingDecision =
  | { readonly show: false }
  | {
      readonly show: true;
      /** Pre-filled from the provider profile, or split from the composite name for a magic-link signup. */
      readonly firstName: string;
      readonly lastName: string;
      /** True for a fresh signup (name their personal org); false for an invited teammate. */
      readonly needsOrgName: boolean;
      /** The personal org to rename, present only when `needsOrgName`. */
      readonly org: { readonly orgId: string; readonly slug: string; readonly name: string } | null;
    };

/** Split a composite display name into a first/last guess — for a magic-link user with no provider profile. */
function splitDisplayName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

export interface OnboardingInput {
  readonly userId: string;
  readonly state: OnboardingStateDto | null;
  readonly orgs: readonly UserOrg[];
}

export function decideOnboarding(input: OnboardingInput): OnboardingDecision {
  const { state } = input;

  // No identity state (the RPC couldn't reach auth, or the user vanished) → don't trap them in onboarding.
  // The gate fails OPEN: a missing signal sends them to the dashboard, never into a loop.
  if (!state) return { show: false };

  // Already onboarded — the common case on every login after the first.
  if (state.onboardedAtIso !== null) return { show: false };

  // Pre-fill the name. Prefer the provider-mapped first/last; fall back to splitting the composite name for a
  // magic-link user who has no given/family fields.
  const split = splitDisplayName(state.name);
  const firstName = state.firstName ?? split.firstName;
  const lastName = state.lastName ?? split.lastName;

  // Invited?  They hold a membership in an org that is NOT their derived personal one.
  const personal = personalOrgId(input.userId);
  const invited = input.orgs.some((o) => o.orgId !== personal);
  const personalOrg = input.orgs.find((o) => o.orgId === personal) ?? null;

  return {
    show: true,
    firstName,
    lastName,
    // A fresh signup names their org; an invited teammate does not. And if — through a bootstrap blip — the
    // user has no personal org to rename, there is nothing to name either, so skip that step rather than
    // present a control that would fail.
    needsOrgName: !invited && personalOrg !== null,
    org: !invited && personalOrg ? personalOrg : null,
  };
}
