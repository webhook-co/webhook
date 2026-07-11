import { cn } from "@webhook-co/ui";

import { Pill } from "@/components/ui/pill";
import { LINKS } from "@/lib/links";
import { container, focusRing } from "@/lib/styles";

/**
 * The top announcement bar.
 *
 * It used to say "soon" and link to a roadmap that didn't exist — framed that way back when the MCP
 * server was genuinely unshipped. It has since shipped, been prod-verified, and picked up a full docs
 * section, while the hero pill two inches below this already said "new". So the bar was
 * simultaneously underselling the product's named differentiator and contradicting the page it sits
 * on. Present tense now, pointing at the docs that exist.
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
        <Pill>new</Pill>
        <span>
          The webhook.co MCP server is live — turn any webhook into an agent event.{" "}
          <a
            href={LINKS.mcp}
            className={cn(
              focusRing,
              "rounded-control text-fg underline decoration-strong underline-offset-2 transition-colors hover:decoration-fg",
            )}
          >
            Read the docs <span aria-hidden="true">→</span>
          </a>
        </span>
      </div>
    </div>
  );
}
