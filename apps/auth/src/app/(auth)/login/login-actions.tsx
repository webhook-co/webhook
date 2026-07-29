"use client";

import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { makeAuthActions } from "@/runtime/auth-client";

import { LoginForm, type ConfiguredProviders } from "./login-form";
import { resolvePostLoginTarget } from "./post-login-target";

// Same-origin: the login page is served from auth.webhook.co, so the browser client calls /api/auth/* on
// the current origin (no baseURL needed). magicLinkClient adds signIn.magicLink to the client.
const authClient = createAuthClient({ plugins: [magicLinkClient()] });

/** Client wrapper that injects the live AuthActions into Lane E's LoginForm (the UI is unchanged).
 *  `providers` comes from the SERVER (page.tsx → configuredSocialProviders) so the buttons match what
 *  Better Auth was actually given; it defaults to both, which is production. */
export function LoginActions({ providers }: { providers?: ConfiguredProviders }) {
  // Post-login destination = the session handoff (the auth.→app. producer that mints the exchange ticket),
  // honoring an issuer `?redirect=`. Computed client-side so window.location is read; see
  // {@link resolvePostLoginTarget}. Landing on app. directly skips the handoff → the /login redirect loop.
  const callbackURL = resolvePostLoginTarget(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const actions = makeAuthActions(authClient, { callbackURL });
  return <LoginForm actions={actions} providers={providers} />;
}
