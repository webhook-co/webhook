"use client";

import { magicLinkClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

import { makeAuthActions } from "@/runtime/auth-client";
import { APP_BASE_URL } from "@/runtime/urls";

import { LoginForm, type AuthActions } from "./login-form";

// Same-origin: the login page is served from auth.webhook.co, so the browser client calls /api/auth/* on
// the current origin (no baseURL needed). magicLinkClient adds signIn.magicLink to the client.
const authClient = createAuthClient({ plugins: [magicLinkClient()] });

// Post-login destination = the app dashboard. The actual auth.→app. session handoff is the backchannel
// session-exchange (A-SX, a later slice); this only tells Better Auth where to land the user afterward.
const actions: AuthActions = makeAuthActions(authClient, { callbackURL: APP_BASE_URL });

/** Client wrapper that injects the live AuthActions into Lane E's LoginForm (the UI is unchanged). */
export function LoginActions() {
  return <LoginForm actions={actions} />;
}
