// A1b-3 — the live AuthActions adapter for Lane E's LoginForm. Maps the form's seam onto the Better Auth
// browser client (signIn.magicLink / signIn.social), threading the post-login callbackURL and converting
// the client's {error} result into a rejection (the form contract: resolve on success, reject on failure).
//
// The Better Auth client is injected (AuthClient) so this stays a pure unit — the concrete browser client
// (createAuthClient + magicLinkClient, which import better-auth/react) is constructed in the "use client"
// wiring component, not here.

/**
 * The slice of the Better Auth browser client we use. signIn.* resolve to `{ error }` (they don't throw).
 * This mirrors Better Auth's `signIn` shape structurally — re-verify on a better-auth upgrade that the
 * concrete `createAuthClient` result is still assignable to this (the call site is the only check).
 */
export interface AuthClient {
  signIn: {
    magicLink: (opts: {
      email: string;
      callbackURL?: string;
      /** Per-request fetch overrides — used to attach the Turnstile token header (see sendMagicLink). */
      fetchOptions?: { headers?: Record<string, string> };
    }) => Promise<{ error?: { message?: string } | null }>;
    social: (opts: {
      provider: "google" | "github";
      callbackURL?: string;
    }) => Promise<{ error?: { message?: string } | null }>;
  };
}

/** Matches Lane E's `AuthActions` (login-form.tsx) structurally; the wiring asserts the assignment. */
export interface LiveAuthActions {
  /** `captchaToken` is the solved Cloudflare Turnstile token — sent as the `x-captcha-response` header
   *  the server's captcha gate reads (the magic-link endpoint rejects a send without it in prod). */
  sendMagicLink(email: string, captchaToken: string): Promise<void>;
  continueWith(provider: "google" | "github"): Promise<void>;
}

export interface AuthActionsOptions {
  /** Where Better Auth lands the user after a verified magic link / completed OAuth callback. */
  callbackURL: string;
}

export function makeAuthActions(client: AuthClient, opts: AuthActionsOptions): LiveAuthActions {
  return {
    async sendMagicLink(email, captchaToken) {
      const { error } = await client.signIn.magicLink({
        email,
        callbackURL: opts.callbackURL,
        fetchOptions: { headers: { "x-captcha-response": captchaToken } },
      });
      if (error) throw new Error(error.message ?? "could not send the sign-in link");
    },
    async continueWith(provider) {
      // On success the live client navigates to the provider (no return); an error means the start failed.
      const { error } = await client.signIn.social({ provider, callbackURL: opts.callbackURL });
      if (error) throw new Error(error.message ?? "could not start sign-in");
    },
  };
}
