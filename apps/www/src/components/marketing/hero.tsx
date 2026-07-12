import { Button, cn } from "@webhook-co/ui";
import { Lock, Scale } from "lucide-react";

import { Inspector } from "@/components/marketing/inspector/inspector";
import { GithubIcon } from "@/components/ui/brand-icons";
import { Pill } from "@/components/ui/pill";
import { focusRing } from "@/lib/styles";

import { LINKS } from "@/lib/links";

const trustSignals = [
  { icon: GithubIcon, label: "Open source" },
  { icon: Scale, label: "Apache-2.0" },
  { icon: Lock, label: "Private by default" },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pt-[clamp(48px,7vw,88px)] pb-[clamp(36px,5vw,60px)]">
      <div className="hero-bg" aria-hidden="true">
        <div className="hero-dots" />
      </div>

      <div className="relative z-10 mx-auto grid max-w-[var(--container-max)] items-center gap-x-12 gap-y-10 min-[940px]:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        {/* Left: the thesis. Centered while stacked (<940px), left-aligned once it's the left column. */}
        <div className="hero-rise flex flex-col items-center text-center min-[940px]:items-start min-[940px]:text-left">
          <a
            href={LINKS.mcp}
            className={cn(
              focusRing,
              "mb-6 inline-flex items-center gap-2 rounded-pill border border-hairline bg-surface py-1 pr-3 pl-1.5 text-sm text-fg-secondary shadow-1 transition-colors hover:text-fg",
            )}
          >
            <Pill>new</Pill>
            <span>MCP-native webhooks</span>
            <span aria-hidden="true">→</span>
          </a>

          <h1 className="mb-6 max-w-[18ch] text-[clamp(38px,5.2vw,62px)] leading-[1.04] font-semibold tracking-display text-balance text-fg">
            The webhook platform built for the agent era
          </h1>

          <p className="mb-8 max-w-[52ch] text-[clamp(17px,2.1vw,20px)] leading-snug tracking-tight text-pretty text-fg-secondary">
            Capture the webhooks other services send you — inspect every request, verify it, replay
            it to localhost. Then hand your agents an event they can act on.
          </p>

          {/* "Try it" read as "try the whole platform" — a free-trial promise the Free tier doesn't
              make. The sandbox is named for what it is (a playground) and lives on the demo it
              belongs to, in the right column; the two hero buttons stay about the product. */}
          <div className="mb-8 flex flex-wrap gap-3">
            <Button asChild size="md">
              <a href={LINKS.startFree}>Start free</a>
            </Button>
            <Button asChild variant="secondary" size="md">
              <a href={LINKS.docs}>Read the docs</a>
            </Button>
          </div>

          <ul className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-fg-muted">
            {trustSignals.map(({ icon: Icon, label }) => (
              <li key={label} className="inline-flex items-center gap-2">
                <Icon size={14} className="text-fg-faint" aria-hidden="true" />
                {label}
              </li>
            ))}
          </ul>
        </div>

        {/* Right: the product itself — the live inspector. Stacks below the thesis under 940px, where
            the 520px cap + mx-auto keep it the same width as in the desktop column and centered (not
            full-bleed). On desktop mx-auto is a no-op — it already fills its 520px grid track. */}
        <div className="hero-rise-inspector mx-auto w-full max-w-[520px]">
          <Inspector />
          {/* The Inspector is an honest DEMO (fixed data, and it says so). The button turns that into
              an offer: the same view, with your own webhook. It sits ON the demo rather than in the
              hero's CTA row so it reads as "this thing, for real" — not as a second way to sign up.
              Deliberately a SIBLING of the card, never a wrapper around it: the Inspector has pause
              and replay buttons, and nesting interactive controls inside a link is invalid and
              keyboard-hostile. */}
          <div className="mt-4 flex justify-center">
            <Button asChild variant="secondary" size="sm">
              <a href={LINKS.play}>Test a webhook in the playground</a>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
