import { AuthShell, ThemeToggle } from "@webhook-co/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginActions } from "./login-actions";
import { resolvePostLoginTarget } from "./post-login-target";
import { isSignedIn } from "./resolve-signed-in";

// Reads the session cookie, so it can never be prerendered or cached.
export const dynamic = "force-dynamic";

/**
 * The query param the app.→auth. handoff sets when it could NOT establish a session (an expired, replayed or
 * otherwise unredeemable ticket). It is the LOOP BREAKER for the signed-in bounce below.
 *
 * Without it: the callback fails → redirects to /login → /login sees a live IdP session → bounces to
 * /session/handoff → mints another ticket → the callback fails again → … an infinite redirect loop that would
 * lock the user out of the product entirely. With it, a failed handoff always lands on a real sign-in form.
 */
const HANDOFF_FAILED_PARAM = "error";

type SearchParams = Record<string, string | string[] | undefined>;

/** Re-serialize the resolved searchParams so the PURE, already-tested target resolver can be reused as-is. */
function toSearchString(params: SearchParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") search.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) search.set(key, value[0]);
  }
  return search.toString();
}

export const metadata: Metadata = {
  title: "Sign in · webhook.co",
  description: "Sign in to webhook.co.",
};

/**
 * The sign-in page's brand panel.
 *
 * It used to carry three figures — "99.99% delivery SLA", "38ms median latency", "3.4M events / day".
 * All three were invented. We measure none of them, and the SLA one directly contradicted the Terms
 * of Service linked at the bottom of this very page, which say the Service is provided "on a
 * best-effort basis with **no guaranteed uptime or service-level commitment**". A number nobody
 * measured is worse than no number: it's the one thing on the page a reader has no way to check, and
 * the first thing that makes them doubt everything else.
 *
 * What's left says what the product DOES, which is true and provable. If we ever want figures here,
 * they have to come from real telemetry — `page.test.tsx` fails if any metric reappears.
 */
function BrandVisual() {
  return (
    <div className="flex flex-col gap-4">
      <p className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-mono-label text-fg-on-inverse/60">
        <span className="size-[7px] rounded-full bg-ok" aria-hidden="true" />
        webhook.co platform
      </p>
      <p className="max-w-[16ch] text-4xl font-semibold leading-[1.12] tracking-display text-balance">
        Ship webhooks you can <span className="text-fg-on-inverse/45">actually trust.</span>
      </p>
      <p className="max-w-[38ch] leading-snug text-fg-on-inverse/65">
        Durable delivery, automatic retries, and end-to-end observability — capture every event,
        replay any of them, and see exactly what happened.
      </p>
    </div>
  );
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const params = (await searchParams) ?? {};

  // Already signed in? Then don't ask again — resume. The IdP session outlives app.'s cookie, so landing here
  // with a live session (a Back navigation, an expired app. cookie, a fresh tab) used to mean re-authenticating
  // for no reason. `resolvePostLoginTarget` carries the same open-redirect guard the client login flow uses
  // (single-leading-slash relative paths only, and never /login itself), and defaults to /session/handoff.
  //
  // Guarded by the loop breaker: if the handoff has just FAILED, show the form instead of bouncing back into
  // the handoff that failed.
  if (params[HANDOFF_FAILED_PARAM] === undefined && (await isSignedIn())) {
    redirect(resolvePostLoginTarget(toSearchString(params)));
  }

  return (
    <AuthShell
      homeHref="/"
      actions={<ThemeToggle />}
      visual={<BrandVisual />}
      footer={
        <p className="text-center text-sm leading-snug text-fg-faint">
          By continuing you agree to webhook.co&apos;s{" "}
          <a href="https://www.webhook.co/terms" className="text-fg-secondary underline">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="https://www.webhook.co/privacy" className="text-fg-secondary underline">
            Privacy Policy
          </a>
          .
        </p>
      }
    >
      <LoginActions />
    </AuthShell>
  );
}
