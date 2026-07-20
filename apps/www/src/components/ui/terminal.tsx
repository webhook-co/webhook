import { cn } from "@webhook-co/ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * A dark code-block "island": it pins `data-theme="dark"` so the terminal stays dark even when the
 * page is in light mode (the page itself defaults to dark). That re-resolves the design-system tokens
 * to their dark values for this subtree, so the terminal is built from the same semantic utilities as
 * everything else — no bespoke hex. `bg-surface-page` resolves to #0b0f14, `text-fg` to #edf2f7,
 * `text-ok` to #22c55e, and so on.
 */
export function Terminal({
  title,
  meta,
  children,
  className,
}: {
  title?: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-theme="dark"
      className={cn(
        "overflow-hidden rounded-card border border-hairline bg-surface-page shadow-3",
        className,
      )}
    >
      {(title || meta) && (
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-3.5 py-2.5">
          <span className="font-mono text-[0.75rem] text-fg-muted">{title}</span>
          {meta ? <span className="font-mono text-[0.75rem] text-fg-muted">{meta}</span> : null}
        </div>
      )}
      {/* Real product output is wide — one `wbhk events list` row is an ISO timestamp plus a uuid — so
          this body scrolls horizontally. A scrollable region MUST be keyboard-reachable, or its
          right-hand columns are pointer-only (axe `scrollable-region-focusable`): hence the tab stop,
          plus the labelled `region` that gives the stop a name. jsx-a11y's `no-noninteractive-tabindex`
          allowlists only `tabpanel` by default, so it flags this exact WAI-ARIA pattern; the a11y
          requirement wins, and the suppression is scoped to this one element. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-tabindex */}
      <div
        role="region"
        aria-label={title ? `${title} output` : "Terminal output"}
        tabIndex={0}
        className="overflow-x-auto px-[22px] py-5 font-mono text-[0.8125rem] leading-[1.85] text-fg"
      >
        {children}
      </div>
      {/* eslint-enable jsx-a11y/no-noninteractive-tabindex */}
    </div>
  );
}

// Syntax tokens — thin spans that tint a run of terminal text. They read like the rendered output
// (`<Tok.Ok>200</Tok.Ok>`) and stay on-token (no dangerouslySetInnerHTML, no hardcoded colour).
const TONE_CLASS = {
  dim: "text-fg-faint",
  mut: "text-fg-secondary",
  ok: "text-ok",
  info: "text-info",
} as const;

function makeTok(tone: keyof typeof TONE_CLASS) {
  return function Tok({ className, ...props }: ComponentPropsWithoutRef<"span">) {
    return <span className={cn(TONE_CLASS[tone], className)} {...props} />;
  };
}

export const Tok = {
  Dim: makeTok("dim"),
  Mut: makeTok("mut"),
  Ok: makeTok("ok"),
  Info: makeTok("info"),
};

/**
 * One monospace row in the terminal. Rows are flex blocks (not literal `<pre>` whitespace) so
 * Prettier can't reflow the rendered output. `data-terminal-line` is the row seam the surface tests
 * read: it lets a test reconstruct the panel's output line by line and compare it to what the real
 * CLI renderer / API / MCP tool actually returns.
 */
export function TerminalLine({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div data-terminal-line="" className={cn("whitespace-pre", className)} {...props} />;
}
