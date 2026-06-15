import { Button, cn } from "@webhook-co/ui";
import { Lock, Scale, ShieldCheck } from "lucide-react";

import { GithubIcon } from "@/components/ui/brand-icons";
import { focusRing } from "@/lib/styles";

const trustSignals = [
  { icon: GithubIcon, label: "Open source" },
  { icon: Scale, label: "Apache-2.0" },
  { icon: ShieldCheck, label: "Standard Webhooks" },
  { icon: Lock, label: "Private by default" },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pt-[clamp(48px,7vw,88px)] pb-[clamp(28px,4vw,44px)] text-center">
      <div className="hero-bg" aria-hidden="true">
        <div className="hero-dots" />
      </div>

      <div className="hero-rise relative z-10 mx-auto flex max-w-[var(--container-max)] flex-col items-center">
        <a
          href="#"
          className={cn(
            focusRing,
            "mb-6 inline-flex items-center gap-2 rounded-pill border border-hairline bg-surface py-1 pr-3 pl-1.5 text-sm text-fg-secondary shadow-1 transition-colors hover:text-fg",
          )}
        >
          <span className="rounded-pill bg-surface-inverse px-2 py-0.5 font-mono text-[10px] uppercase tracking-mono-label text-fg-on-inverse">
            new
          </span>
          <span>MCP-native webhooks</span>
          <span aria-hidden="true">→</span>
        </a>

        <h1 className="mb-6 max-w-[16ch] text-[clamp(40px,6.6vw,76px)] leading-[1.02] font-semibold tracking-display text-balance text-fg">
          The webhook platform built for the agent era
        </h1>

        <p className="mb-8 max-w-[60ch] text-[clamp(17px,2.1vw,21px)] leading-snug tracking-tight text-pretty text-fg-secondary">
          Capture any webhook, inspect every request, and replay it to localhost. Then hand your
          agents an event they can act on.
        </p>

        <div className="mb-8 flex flex-wrap justify-center gap-3">
          <Button asChild size="md">
            <a href="#">Start free</a>
          </Button>
          <Button asChild variant="secondary" size="md">
            <a href="#">Read the docs</a>
          </Button>
        </div>

        <ul className="flex flex-wrap justify-center gap-x-5 gap-y-2 font-mono text-xs text-fg-muted">
          {trustSignals.map(({ icon: Icon, label }) => (
            <li key={label} className="inline-flex items-center gap-2">
              <Icon size={14} className="text-fg-faint" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
