import * as React from "react";

import { cn } from "../lib/cn";

/**
 * A single shimmering placeholder block.
 *
 * The dashboard is force-dynamic and does a few Postgres reads before it can render, so a navigation used to
 * show NOTHING until the server render came back — a blank frame that reads as "hung", especially on the very
 * pages this whole effort is trying to make feel faster. A `loading.tsx` built from these renders instantly on
 * navigation and holds the page's shape while the data loads, which is the difference between "nothing is
 * happening" and "it's coming".
 *
 * `bg-surface-sunken` + `animate-pulse` is the exact treatment already hand-rolled across the codebase; this
 * is that, in one place, so a skeleton cannot drift from the surface it stands in for.
 *
 * `prefers-reduced-motion` stops the pulse — the block stays, the animation does not, matching how `Spinner`
 * already behaves.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // Decorative: the surrounding container carries `aria-busy` / an sr-only "Loading…", so each individual
      // shimmer must NOT announce itself, or a screen reader hears "blank blank blank".
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded bg-surface-sunken motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A stack of skeleton lines — the body of a loading card. The last line is short, the way a real paragraph
 * ends, so the placeholder reads as text rather than as a grid of identical bars.
 */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
