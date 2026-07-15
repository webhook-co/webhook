"use server";

import { MAX_DISPLAY_NAME_LEN } from "@/lib/profile-constants";

import { getOnboardingBinding } from "./env";
import { logActionError } from "./action-log";
import { remintSessionForProfile } from "./session-remint";
import { verifySession } from "./session";

// Edit the signed-in user's DISPLAY name. The `user` table is the global identity realm that only auth.
// (webhook_auth) may write, so this verifies the session and RPCs the OnboardingProfile binding with its OWN
// userId — the same boundary onboarding crosses. On success it RE-MINTS the session cookie so the new name is
// live everywhere immediately (nav, avatar, greeting), not just after the next login.
//
// dal-gate-allow: user-scoped — gates on verifySession; the identity write is the caller's own, over the RPC.

export type UpdateNameResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

export async function updateDisplayNameAction(formData: FormData): Promise<UpdateNameResult> {
  const session = await verifySession();

  const raw = formData.get("name");
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0) return { ok: false, error: "Give yourself a name." };
  // Cap NEW growth only — a user whose stored name already exceeds the cap (a long onboarding composite, or an
  // uncapped OAuth name) can still edit it, as long as they don't make it longer. Never a hard lockout.
  if (name.length > MAX_DISPLAY_NAME_LEN && name.length > session.user.name.length) {
    return { ok: false, error: `Keep your name under ${MAX_DISPLAY_NAME_LEN} characters.` };
  }
  // No-op if unchanged from what's displayed — skip the write + re-mint entirely.
  if (name === session.user.name) return { ok: true };

  const binding = getOnboardingBinding();
  if (!binding) {
    return {
      ok: false,
      error: "Profile editing is temporarily unavailable. Please try again shortly.",
    };
  }

  // The RPC can throw — a transient Hyperdrive/DB fault, or a method-not-found during a web-before-auth deploy
  // window (the structural check in getOnboardingBinding can't catch that: a bound RPC stub is a Proxy that
  // fabricates a callable for any name). Catch it so the user gets the inline banner, not an error screen.
  let updated: boolean;
  try {
    ({ updated } = await binding.updateName(session.userId, name));
  } catch (error) {
    logActionError("profile.update_name_rpc", error);
    return {
      ok: false,
      error: "Profile editing is temporarily unavailable. Please try again shortly.",
    };
  }
  if (!updated) {
    // The DB refused (user gone, or an empty name slipped past — defense in depth). Don't claim success.
    return { ok: false, error: "We couldn't update your name. Please try again." };
  }

  // Re-mint the cookie so `session.user.name` reflects the change app-wide right away. A missing/expired
  // session here is not fatal to the write that already succeeded — the name still updates on next login.
  await remintSessionForProfile({
    name,
    email: session.user.email,
    image: session.user.image,
  });

  return { ok: true };
}
