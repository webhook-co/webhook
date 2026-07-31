"use client";

import { Banner } from "@webhook-co/ui";
import * as React from "react";

import { exchangeOneTapCredential, type OneTapOutcome } from "./one-tap-exchange";

// Google One Tap on the login page: a returning visitor with a live Google session gets a prompt and can
// sign in with one tap instead of a redirect round-trip to Google's account chooser.
//
// This owns the Google Identity Services lifecycle directly rather than calling better-auth's
// `oneTapClient()`. one-tap-exchange.ts carries the full reasoning — briefly: that plugin holds a
// MODULE-LEVEL in-progress flag that can stick true forever under FedCM (killing One Tap for the rest of
// the JS context), retries a dismissed prompt on a 31-second ladder of timers nothing cancels, never
// calls `cancel()`, and leaks a dead `<script>` when the load fails. The script loading below is modelled
// on turnstile.tsx, which already solves the same problem correctly in this codebase.
//
// PROMPT, THEN TAP TO CONFIRM — never silent. `auto_select` is false, so a returning user is always shown
// the prompt and must confirm; we never sign someone in merely because a Google session exists.
//
// THREE OUTCOMES, THREE BEHAVIOURS, and the asymmetry is deliberate:
//   • Dismissed / not displayed → nothing. The user never asked for this; a banner would be noise.
//   • Script or Google unavailable → a console warning only. The page is fully usable without One Tap,
//     so a visible error would report OUR degraded enhancement as THEIR problem.
//   • Exchange rejected → a visible danger banner. The user actively tapped and confirmed, and silence
//     there is exactly the "clicking does nothing" bug login-form.tsx documents.

const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

interface CredentialResponse {
  credential?: string;
}

interface GoogleIdApi {
  initialize: (config: {
    client_id: string;
    callback: (response: CredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    context?: "signin" | "signup" | "use";
    itp_support?: boolean;
    use_fedcm_for_prompt?: boolean;
  }) => void;
  prompt: () => void;
  cancel: () => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } };
  }
}

let scriptPromise: Promise<void> | null = null;

/**
 * Load Google's GSI script once per document; later callers await the same promise.
 *
 * On failure it resets `scriptPromise` AND removes the dead `<script>` before rejecting, so a retry
 * neither reuses a poisoned promise nor accumulates tags — the two things better-auth's own loader gets
 * wrong. Same shape as `loadTurnstileScript`, minus the leak.
 */
function loadGoogleScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      scriptPromise = null; // allow a retry on the next mount
      script.remove(); // …without leaving a dead tag behind
      reject(new Error("failed to load the Google Identity Services script"));
    });
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export interface OneTapProps {
  /** The Google OAuth client id, resolved on the SERVER from the Secrets Store binding. */
  clientId: string;
  /** Where to land after a successful sign-in — `resolvePostLoginTarget`'s answer. */
  callbackURL: string;
  /** Test seam: the credential-for-session exchange. Defaults to the real one. */
  exchange?: (input: { credential: string; callbackURL: string }) => Promise<OneTapOutcome>;
  /** Test seam: performs the post-sign-in navigation. Defaults to a real location assignment. */
  navigate?: (target: string) => void;
}

export function OneTap({ clientId, callbackURL, exchange, navigate }: OneTapProps) {
  const [error, setError] = React.useState<string | null>(null);

  // The effect's inputs are held in a ref so the effect can depend only on `clientId`/`callbackURL`.
  // Without this, passing an inline `exchange` (or a fresh `navigate`) would re-run the whole prompt
  // lifecycle on every parent render.
  const seams = React.useRef({ exchange, navigate });
  seams.current = { exchange, navigate };

  React.useEffect(() => {
    // ONE initialize+prompt per mount, achieved by cancellation rather than by a fire-once ref.
    //
    // React StrictMode double-invokes effects in development (next.config.ts turns it on): effect →
    // cleanup → effect, all within the same commit and therefore all before any microtask runs. So the
    // first pass is already cancelled by the time `loadGoogleScript()` resolves and never reaches
    // `initialize`, and the second pass does the real work. Net: exactly one of each.
    //
    // A `useRef` "only ever fire once" guard looks like the obvious fix and is actively wrong here — it
    // makes the FIRST (doomed) pass claim the single allowed attempt and the second return early, so
    // One Tap never prompts at all in development. A test pins this, because the symptom is
    // dev-environment-only and would read as "Google isn't showing the prompt today".
    let cancelled = false;

    const onCredential = (response: CredentialResponse) => {
      const credential = response?.credential;
      if (cancelled || typeof credential !== "string" || credential.length === 0) return;

      const run = seams.current.exchange ?? exchangeOneTapCredential;
      void run({ credential, callbackURL })
        .then((outcome) => {
          if (cancelled) return;
          if (outcome.status === "signed-in") {
            const go = seams.current.navigate ?? ((t: string) => window.location.assign(t));
            go(outcome.target);
            return;
          }
          setError(outcome.message);
        })
        .catch(() => {
          // exchangeOneTapCredential is total, so this is unreachable in practice — but an unhandled
          // rejection inside a Google callback would surface as a console error on the login page.
          if (!cancelled)
            setError("We couldn't sign you in with Google. Try another option below.");
        });
    };

    loadGoogleScript()
      .then(() => {
        const api = window.google?.accounts?.id;
        if (cancelled || !api) return;
        api.initialize({
          client_id: clientId,
          callback: onCredential,
          // Never silent: always prompt, always require a tap to confirm.
          auto_select: false,
          cancel_on_tap_outside: true,
          context: "signin",
          // Intelligent Tracking Prevention support (Safari) and the FedCM prompt, which is the only
          // path Chrome will keep once third-party cookies are gone.
          itp_support: true,
          use_fedcm_for_prompt: true,
        });
        // No notification handler and no retry: a user who dismissed the prompt has answered, and
        // re-asking is the behaviour that makes One Tap feel like a popup ad.
        api.prompt();
      })
      .catch((cause: unknown) => {
        // Deliberately console-only. One Tap is an enhancement on a page that already works; a blocked
        // gsi/client (an extension, a strict network, an outage) must not put an error in front of a user
        // who can still sign in three other ways on this very page.
        console.warn("google one tap unavailable", cause instanceof Error ? cause.message : cause);
      });

    return () => {
      cancelled = true;
      // Take the prompt down with the page. Without this the overlay can outlive the route that owns it.
      window.google?.accounts?.id?.cancel();
    };
  }, [clientId, callbackURL]);

  if (!error) return null;
  return (
    <Banner tone="danger" className="mb-4">
      {error}
    </Banner>
  );
}
