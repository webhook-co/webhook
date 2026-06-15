import { cn } from "@webhook-co/ui";

import { Pill } from "@/components/ui/pill";
import { container, focusRing } from "@/lib/styles";

/**
 * The top announcement bar. The MCP server isn't GA yet, so this is framed as roadmap
 * ("soon") rather than a present-tense launch — honest top-of-funnel, per the positioning call.
 */
export function AnnounceBar() {
  return (
    <div className="border-b border-hairline bg-surface">
      <div
        className={cn(
          container,
          "flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 py-[9px] text-center text-sm text-fg-secondary",
        )}
      >
        <Pill>soon</Pill>
        <span>
          The webhook.co MCP server — turn any webhook into an agent event.{" "}
          <a
            href="#"
            className={cn(
              focusRing,
              "rounded-control text-fg underline decoration-strong underline-offset-2 transition-colors hover:decoration-fg",
            )}
          >
            See the roadmap <span aria-hidden="true">→</span>
          </a>
        </span>
      </div>
    </div>
  );
}
