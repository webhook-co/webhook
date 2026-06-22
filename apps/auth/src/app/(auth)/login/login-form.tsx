"use client";

import { Banner, Button, Field } from "@webhook-co/ui";
import * as React from "react";

import { Turnstile } from "./turnstile";

/**
 * The seam between the login UI and the auth backend. E3 ships a {@link mockAuthActions}
 * implementation so the page is fully buildable + reviewable before Lane C's `/api/auth/*`
 * exists; E8 swaps in the live `@webhook-co/contract` client without touching this component.
 */
export interface AuthActions {
  /** Request a magic-link email for `email`, passing the solved Turnstile token (the server gate requires
   *  it). Resolves once sent; rejects on failure. */
  sendMagicLink(email: string, captchaToken: string): Promise<void>;
  /** Begin an OAuth flow. The live impl redirects; the mock resolves. */
  continueWith(provider: "google" | "github"): Promise<void>;
}

/** A captcha widget seam: reports the solved token (or null when it expires/errors/resets). Defaults to the
 *  real {@link Turnstile}; the form tests inject a fake through this prop (same pattern as `actions`). */
export interface CaptchaWidgetProps {
  onToken: (token: string | null) => void;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Mock seam for E3 — replaced by the live client in E8. Never sends anything. */
export const mockAuthActions: AuthActions = {
  async sendMagicLink() {
    await wait(600);
  },
  async continueWith() {
    await wait(400);
  },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Pending = null | "magic" | "google" | "github";

const GoogleGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
    />
  </svg>
);

const GithubGlyph = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.5 11.5 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
    />
  </svg>
);

export function LoginForm({
  actions = mockAuthActions,
  Captcha = Turnstile,
}: {
  actions?: AuthActions;
  Captcha?: React.ComponentType<CaptchaWidgetProps>;
}) {
  const [email, setEmail] = React.useState("");
  const [pending, setPending] = React.useState<Pending>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = React.useState<string | null>(null);
  // Bumping this remounts the captcha to get a fresh single-use token after a failed send.
  const [captchaNonce, setCaptchaNonce] = React.useState(0);

  const busy = pending !== null;

  async function handleMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setEmailError(null);
    setFormError(null);
    if (!EMAIL_RE.test(email)) {
      setEmailError("Enter a valid email address.");
      return;
    }
    if (!captchaToken) {
      // The submit button is disabled until the captcha resolves, so this is just a belt-and-braces guard.
      setFormError("Please wait for the verification to finish, then try again.");
      return;
    }
    setPending("magic");
    try {
      await actions.sendMagicLink(email, captchaToken);
      setSentTo(email);
    } catch {
      setFormError("We couldn't send the link. Please try again.");
      // The token was consumed (single-use) by the attempt — drop it + remount for a fresh one.
      setCaptchaToken(null);
      setCaptchaNonce((n) => n + 1);
    } finally {
      setPending(null);
    }
  }

  async function handleProvider(provider: "google" | "github") {
    setEmailError(null);
    setFormError(null);
    setPending(provider);
    try {
      // The live action redirects to the provider; the mock resolves without navigating.
      await actions.continueWith(provider);
    } catch {
      setFormError("That didn't work. Please try again.");
    } finally {
      // Reset so the non-redirecting mock leaves the form usable; harmless on the live path,
      // where the redirect has already navigated away.
      setPending(null);
    }
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-4" role="status">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-heading text-fg">Check your email</h1>
          <p className="leading-snug text-fg-secondary">
            We sent a magic link to <span className="font-medium text-fg">{sentTo}</span>. Open it
            on this device to finish signing in.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setSentTo(null)}>
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Sign in to webhook.co</h1>
        <p className="leading-snug text-fg-secondary">
          Welcome back. Pick how you&apos;d like to continue.
        </p>
      </div>

      {formError ? <Banner tone="danger">{formError}</Banner> : null}

      <div className="flex flex-col gap-2.5">
        <Button variant="secondary" disabled={busy} onClick={() => handleProvider("google")}>
          <GoogleGlyph />
          Continue with Google
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => handleProvider("github")}>
          <GithubGlyph />
          Continue with GitHub
        </Button>
      </div>

      <div className="flex items-center gap-3 font-mono text-xs uppercase tracking-mono-label text-fg-faint">
        <span className="h-px flex-1 bg-hairline" />
        magic link
        <span className="h-px flex-1 bg-hairline" />
      </div>

      <form className="flex flex-col gap-3" onSubmit={handleMagicLink} noValidate>
        <Field
          label="Work email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={emailError ?? undefined}
          disabled={busy}
        />
        <Captcha key={captchaNonce} onToken={setCaptchaToken} />
        <Button type="submit" disabled={busy || !captchaToken}>
          {pending === "magic" ? "Sending…" : "Send magic link"}
        </Button>
      </form>

      <Button variant="secondary" disabled aria-label="SAML single sign-on, coming soon">
        Continue with SSO
      </Button>

      <p className="text-sm text-fg-secondary">
        Don&apos;t have an account?{" "}
        <a href="/login" className="text-fg underline">
          Sign up
        </a>
      </p>
    </div>
  );
}
