import { AuthShell, ThemeToggle } from "@webhook-co/ui";
import type { Metadata } from "next";

import { LoginActions } from "./login-actions";

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

export default function LoginPage() {
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
