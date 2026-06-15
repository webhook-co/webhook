import { cn } from "@webhook-co/ui";
import type { ReactNode } from "react";

/**
 * The MCP & agents visual: a received webhook moving through verify → dedup → agent event, with a
 * slow info-tinted scan sweeping the card. The sweep is the only motion (CSS loop in `marketing.css`,
 * reduced-motion-safe); the rows are static and fully legible without it.
 */
export function TraceFlow() {
  return (
    <div className="relative overflow-hidden rounded-card border border-hairline bg-surface p-6 shadow-2">
      <span className="trace-sweep" aria-hidden="true" />
      <TraceRow step="14:02:11">POST /e/3f2a · stripe · invoice.paid</TraceRow>
      <TraceStem />
      <TraceRow step="verify" ok>
        signature ok
      </TraceRow>
      <TraceStem />
      <TraceRow step="dedup" ok>
        first delivery
      </TraceRow>
      <TraceStem />
      <TraceRow step="→ agent" final>
        event: webhook.received
      </TraceRow>
    </div>
  );
}

function TraceRow({
  step,
  ok = false,
  final = false,
  children,
}: {
  step: string;
  ok?: boolean;
  final?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative flex items-center gap-3 text-sm",
        final ? "font-medium text-fg" : "text-fg-secondary",
      )}
    >
      <span className={cn("min-w-[64px] font-mono text-xs", final ? "text-info" : "text-fg-muted")}>
        {step}
      </span>
      {ok ? (
        <span className="font-bold text-ok" aria-hidden="true">
          ✓
        </span>
      ) : null}
      <span>{children}</span>
    </div>
  );
}

function TraceStem() {
  return <div className="ml-[31px] h-[18px] w-px bg-strong" aria-hidden="true" />;
}
