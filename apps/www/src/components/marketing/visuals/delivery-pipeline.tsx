import { cn } from "@webhook-co/ui";
import type { ReactNode } from "react";

/**
 * The ingestion & delivery visual: a happy-path lane (a dot flows along it — the CSS loop in
 * `marketing.css`) and a failure lane (retry → backoff → dead-letter → replay). The node chains can
 * scroll horizontally on narrow screens rather than overflow the card.
 */
export function DeliveryPipeline() {
  return (
    <div className="rounded-card border border-hairline bg-surface px-5 pt-6 pb-5 shadow-2">
      <p className="mb-5 font-mono text-[11.5px] text-fg-muted">
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
          "mb-3 inline-flex items-center gap-[7px] font-mono text-[10px] tracking-mono-label uppercase",
          tone === "ok" ? "text-ok" : "text-fg-muted",
        )}
      >
        <span
          className={cn("h-1.5 w-1.5 rounded-pill", tone === "ok" ? "bg-ok" : "bg-warn")}
          aria-hidden="true"
        />
        {tag}
      </span>
      <div className="relative flex items-center justify-between gap-1.5 overflow-x-auto py-1">
        {children}
      </div>
    </div>
  );
}

function PipeNode({ children, soft = false }: { children: ReactNode; soft?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-control border bg-surface-page px-[11px] py-[7px] font-mono text-[11.5px] whitespace-nowrap",
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
