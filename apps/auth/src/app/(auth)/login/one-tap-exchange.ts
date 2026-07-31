import { ONE_TAP_CALLBACK_URL_PATH } from "@/runtime/urls";

import { resolvePostLoginTarget } from "./post-login-target";

// Trade a Google One Tap credential for a webhook.co session.
//
// This is the security-relevant half of One Tap, deliberately split out of the React component so it can
// be tested without a browser: what we send, how each response is judged, and where we are willing to
// send the browser afterwards. The component owns the Google lifecycle; this owns the exchange.
//
// WHY WE DO THIS OURSELVES rather than calling better-auth's `oneTapClient()`. Its browser half was read
// end to end (1.6.25) and cannot deliver the guarantees this page needs:
//
//   - `isRequestInProgress` is a MODULE-LEVEL global, cleared only in a `finally` that waits on the prompt
//     promise settling. Under FedCM, Google may never fire a prompt notification, so that promise can
//     stay pending forever and the flag sticks true — after which every later call no-ops with a
//     `console.warn`. One client-side navigation back to /login and One Tap is silently dead for the rest
//     of the JS context, with no error and nothing a test would catch.
//   - It retries a dismissed prompt on an exponential ladder (1+2+4+8+16s) of `setTimeout`s that nothing
//     cancels, so they outlive unmount and can re-prompt on a page the user has already left.
//   - It never calls `google.accounts.id.cancel()`, so there is no way to take the prompt down.
//   - Its script loader rejects without removing the failed `<script>`, leaking a dead tag per attempt.
//   - With no `callbackURL` it navigates to `"/"`, skipping `/session/handoff` — the exact loop
//     post-login-target.tsx exists to prevent.
//
// The endpoint contract is one POST, and one-tap-contract.test.ts pins it against a real better-auth
// instance, so owning the client half costs us no coverage and buys a lifecycle we can actually reason
// about. The SERVER plugin is still better-auth's — only the browser half is ours.

/** The one message One Tap ever puts on screen. Sentence case, no jargon, and it names a way forward. */
export const ONE_TAP_ERROR = "We couldn't sign you in with Google. Try another option below.";

export interface OneTapExchangeInput {
  /** The Google ID token (`CredentialResponse.credential`). */
  credential: string;
  /** Where to land after a successful sign-in — normally `/session/handoff`. */
  callbackURL: string;
}

export type OneTapOutcome =
  { status: "signed-in"; target: string } | { status: "rejected"; message: string };

/**
 * POST the credential to better-auth's One Tap endpoint and decide what happens next.
 *
 * Judged on the BODY, not just the status. The endpoint answers a token with no email claim with a **200**
 * carrying `{ error }` rather than a 4xx, so trusting the status alone would navigate a user who was never
 * signed in straight into a bounce off the app.
 *
 * The returned `target` is re-validated through `resolvePostLoginTarget` even though the caller's value
 * already came from it and the server now re-checks it against `trustedOrigins`. That is deliberate: this
 * is the value that reaches `window.location`, and a guard immediately before the navigation is the one
 * that cannot be bypassed by a refactor somewhere upstream. It costs a single call.
 */
export async function exchangeOneTapCredential(
  input: OneTapExchangeInput,
  fetchFn: typeof fetch = fetch,
): Promise<OneTapOutcome> {
  const rejected: OneTapOutcome = { status: "rejected", message: ONE_TAP_ERROR };
  try {
    const response = await fetchFn(ONE_TAP_CALLBACK_URL_PATH, {
      method: "POST",
      // Same-origin: the login page is served from the same host as the endpoint. Without credentials the
      // Set-Cookie is dropped and the exchange "succeeds" while signing nobody in.
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken: input.credential, callbackURL: input.callbackURL }),
    });

    if (!response.ok) return rejected;

    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) return rejected;

    return { status: "signed-in", target: safeTarget(input.callbackURL) };
  } catch {
    // A network fault, an HTML error page from an edge, a JSON parse failure — all the same answer. The
    // user tapped and confirmed, so this has to surface rather than fail silently.
    return rejected;
  }
}

/**
 * The final open-redirect guard, applied to the value that is about to reach `window.location`.
 *
 * `resolvePostLoginTarget` takes a `?redirect=`-style query string, so the already-resolved path is fed
 * back through it as one. Anything it refuses — an absolute off-origin URL, a `//` or `/\` origin escape,
 * a `javascript:` scheme, or `/login` itself — collapses to the session handoff, which is the correct
 * destination for a plain sign-in anyway.
 */
function safeTarget(candidate: string): string {
  return resolvePostLoginTarget(new URLSearchParams({ redirect: candidate }).toString());
}
