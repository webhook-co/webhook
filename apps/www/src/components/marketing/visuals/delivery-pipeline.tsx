import { cn } from "@webhook-co/ui";

import { focusRing } from "@/lib/styles";
import type { ReactNode } from "react";

/**
 * The ingestion & delivery visual: a happy-path lane (a dot flows along it — the CSS loop in
 * `marketing.css`) and a failure lane (retry → backoff → dead-letter → replay). The node chains can
 * scroll horizontally on narrow screens rather than overflow the card.
 */
export function DeliveryPipeline() {
  return (
    <div className="rounded-card border border-hairline bg-surface px-5 pt-6 pb-5 shadow-2">
      <p className="mb-5 font-mono text-[0.71875rem] text-fg-muted">
        event <span className="text-fg-secondary">twilio · message.received</span>
      </p>
      <Lane tag="happy path" tone="ok">
        <PipeNode>receive</PipeNode>
        <PipeLink />
        <PipeNode>verify</PipeNode>
        <PipeLink />
        <PipeNode>dedup</PipeNode>
        <PipeLink />
        <PipeNode>queue</PipeNode>
        <PipeLink />
        <PipeNode>deliver</PipeNode>
        <span className="flow-dot" aria-hidden="true" />
      </Lane>

      <Lane tag="on failure" divided>
        <PipeNode>retry</PipeNode>
        <PipeLink dashed />
        <PipeNode>backoff</PipeNode>
        <PipeLink dashed />
        <PipeNode soft>dead-letter</PipeNode>
        <PipeLink dashed />
        <PipeNode>replay</PipeNode>
      </Lane>

      <p className="mt-5 border-t border-hairline pt-3.5 font-mono text-xs text-fg-muted">
        first-in-first-out per endpoint · held, not dropped
      </p>
    </div>
  );
}

function Lane({
  tag,
  tone = "neutral",
  divided = false,
  children,
}: {
  tag: string;
  tone?: "ok" | "neutral";
  /** Adds the top divider + spacing when this lane follows another. */
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn(divided && "mt-5 border-t border-hairline pt-5")}>
      <span
        className={cn(
          "mb-3 inline-flex items-center gap-[0.4375rem] font-mono text-[0.625rem] tracking-mono-label uppercase",
          tone === "ok" ? "text-ok" : "text-fg-muted",
        )}
      >
        <span
          className={cn("h-1.5 w-1.5 rounded-pill", tone === "ok" ? "bg-ok" : "bg-warn")}
          aria-hidden="true"
        />
        {tag}
      </span>
      {/* The lane scrolls sideways on a narrow card — which makes it a SCROLLABLE REGION, and a
          scrollable region a keyboard user cannot reach is a WCAG failure (axe:
          scrollable-region-focusable). The desktop axe scan never saw this, because at 1120px the lane
          doesn't overflow and so isn't scrollable at all; the mobile scan found it immediately. Same
          treatment the terminal already has: a named, focusable region.
          `justify-start` (not `justify-between`) so the first node stays at the left edge when the
          content overflows, rather than being pushed out of view. */}
      {/* jsx-a11y forbids tabIndex on a non-interactive element, but axe REQUIRES a scrollable region
      to be keyboard-reachable (scrollable-region-focusable) — the two rules genuinely conflict here,
      and axe is the one describing a real user being unable to reach the content. Same resolution
      as ui/terminal.tsx. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- see above: axe requires it */}
      <div
        role="region"
        aria-label={`${tag} pipeline`}
        tabIndex={0}
        className={cn(
          focusRing,
          "relative flex items-center justify-start gap-1.5 overflow-x-auto py-1 min-[560px]:justify-between",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function PipeNode({ children, soft = false }: { children: ReactNode; soft?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-control border bg-surface-page px-[0.6875rem] py-[0.4375rem] font-mono text-[0.71875rem] whitespace-nowrap",
        soft ? "border-dashed border-strong text-fg-muted" : "border-hairline text-fg-secondary",
      )}
    >
      {children}
    </span>
  );
}

function PipeLink({ dashed = false }: { dashed?: boolean }) {
  return (
    <span
      className={cn(
        "min-w-[14px] flex-1",
        dashed ? "border-t border-dashed border-strong" : "h-px bg-strong",
      )}
      aria-hidden="true"
    />
  );
}
