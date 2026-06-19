import { AuthShell, ThemeToggle } from "@webhook-co/ui";
import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · webhook.co",
  description: "Sign in to webhook.co.",
};

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
        Durable delivery, automatic retries, and end-to-end observability — so every event lands,
        and you can prove it.
      </p>
      <div className="mt-4 flex flex-wrap gap-8">
        <Stat n="99.99%" k="delivery SLA" />
        <Stat n="38ms" k="median latency" />
        <Stat n="3.4M" k="events / day" />
      </div>
    </div>
  );
}

function Stat({ n, k }: { n: string; k: string }) {
  return (
    <div className="flex flex-col">
      <span className="font-mono text-2xl">{n}</span>
      <span className="text-sm text-fg-on-inverse/60">{k}</span>
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
          <a href="/terms" className="text-fg-secondary underline">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href="/privacy" className="text-fg-secondary underline">
            Privacy Policy
          </a>
          .
        </p>
      }
    >
      <LoginForm />
    </AuthShell>
  );
}
