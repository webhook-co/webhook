import { cn } from "@webhook-co/ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * A dark code-block "island" on the otherwise light page. Setting `data-theme="dark"` re-resolves
 * the design-system tokens to their dark values for this subtree, so the terminal is built from the
 * same semantic utilities as everything else — no bespoke hex. `bg-surface-page` resolves to #0b0f14,
 * `text-fg` to #edf2f7, `text-ok` to #22c55e, and so on.
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
          <span className="font-mono text-[11px] text-fg-muted">{title}</span>
          {meta ? <span className="font-mono text-[11px] text-fg-muted">{meta}</span> : null}
        </div>
      )}
      <div className="overflow-x-auto px-[18px] py-4 font-mono text-[12.5px] leading-[1.85] text-fg">
        {children}
      </div>
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
 * One monospace row in the terminal. `highlight` marks the replayed line — its pulsing tint lives in
 * `marketing.css` (`.term-hl`) since it needs a `color-mix` + inset shadow that Tailwind utilities
 * can't express cleanly. Rows are flex blocks (not literal `<pre>` whitespace) so Prettier can't
 * reflow the rendered output.
 */
export function TerminalLine({
  highlight = false,
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { highlight?: boolean }) {
  return <div className={cn("whitespace-pre", highlight && "term-hl", className)} {...props} />;
}
