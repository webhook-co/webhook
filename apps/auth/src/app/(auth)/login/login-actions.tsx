"use client";

import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { makeAuthActions } from "@/runtime/auth-client";

import { LoginForm, type ConfiguredProviders } from "./login-form";
import { OneTap } from "./one-tap";
import { resolvePostLoginTarget } from "./post-login-target";

// Same-origin: the login page is served from auth.webhook.co, so the browser client calls /api/auth/* on
// the current origin (no baseURL needed). magicLinkClient adds signIn.magicLink to the client.
const authClient = createAuthClient({ plugins: [magicLinkClient()] });

/** Client wrapper that injects the live AuthActions into Lane E's LoginForm (the UI is unchanged).
 *  `providers` comes from the SERVER (page.tsx → configuredSocialProviders) so the buttons match what
 *  Better Auth was actually given; it defaults to both, which is production. */
export function LoginActions({
  providers,
  googleClientId,
}: {
  providers?: ConfiguredProviders;
  /**
   * The Google client id for One Tap, resolved on the SERVER (page.tsx → googleOneTapClientId) from the
   * same Secrets Store binding that keys the "Continue with Google" button. `null` means "do not offer
   * One Tap", and it is null for every reason that matters: no Google OAuth app configured, a
   * mis-provisioned secret, or a value that is not shaped like a client id. When it is null, NO Google
   * script is loaded and no request reaches accounts.google.com.
   */
  googleClientId?: string | null;
}) {
  // Post-login destination = the session handoff (the auth.→app. producer that mints the exchange ticket),
  // honoring an issuer `?redirect=`. Computed client-side so window.location is read; see
  // {@link resolvePostLoginTarget}. Landing on app. directly skips the handoff → the /login redirect loop.
  const callbackURL = resolvePostLoginTarget(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const actions = makeAuthActions(authClient, { callbackURL });
  // One Tap needs BOTH a resolved client id and the Google provider actually configured. The two come
  // from the same secret so they agree in practice; requiring both means a future change to either gate
  // can only ever turn the prompt OFF, never leave it on with a provider that cannot complete it.
  const oneTap = googleClientId && providers?.google !== false ? googleClientId : null;
  return (
    <>
      {oneTap ? <OneTap clientId={oneTap} callbackURL={callbackURL} /> : null}
      <LoginForm actions={actions} providers={providers} />
    </>
  );
}
