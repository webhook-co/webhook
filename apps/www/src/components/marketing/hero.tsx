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

      {/* `grid-cols-1` is LOAD-BEARING, not decoration — the same fix `product-shell.tsx` carries.
          Columns were declared only at `min-[940px]`, so below that the stack landed in an IMPLICIT
          column, which is `auto`-sized: floored at its content's min-content width. The inspector's
          failed row ends in a `white-space: nowrap` status line, so that floor was 379px inside a
          345px container and the card ran off the right edge of every phone. Tailwind's `grid-cols-1`
          is `repeat(1, minmax(0, 1fr))` — the column may SHRINK, so wide content clips inside its own
          box instead of pushing the layout. `min-w-0` on the children is the same fix for the
          two-column case above 940px, where a grid item's automatic min-width is also min-content. */}
      <div className="relative z-10 mx-auto grid max-w-[var(--container-max)] grid-cols-1 items-center gap-x-12 gap-y-10 min-[940px]:grid-cols-[minmax(0,1fr)_minmax(0,520px)]">
        {/* Left: the thesis. Centered while stacked (<940px), left-aligned once it's the left column. */}
        <div className="hero-rise flex min-w-0 flex-col items-center text-center min-[940px]:items-start min-[940px]:text-left">
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

          {/* No "Start free" here: the nav's "Get started" button is the same door, in view on the
              same screen, and two buttons to one destination is a choice the reader has to make for
              nothing. That frees the hero's primary slot for the one thing a stranger can do WITHOUT
              an account — the sandbox. ("Try it" was rejected as a name: it promised a trial of the
              whole platform, which the Free tier doesn't offer. "Open playground" says what it is.)
              Sign-up still closes the page: the final CTA carries "Start free". */}
          <div className="mb-8 flex flex-wrap gap-3">
            <Button asChild size="md">
              <a href={LINKS.play}>Open playground</a>
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
        <div className="hero-rise-inspector mx-auto w-full max-w-[520px] min-w-0">
          <Inspector />
        </div>
      </div>
    </section>
  );
}
