import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Text input. Card surface, hairline border, mono-friendly for ids and tokens. Focus
 * shows the standard ring; the invalid state borrows the danger border without
 * shouting (no red fill).
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type ?? "text"}
        className={cn(
          "flex h-[42px] w-full rounded-control border border-strong bg-surface px-3 text-base text-fg",
          "font-sans placeholder:text-fg-faint",
          "transition-[box-shadow,border-color] duration-[var(--wh-dur-fast)] ease-[var(--wh-ease-swift)]",
          "outline-none focus-visible:border-focus focus-visible:shadow-[var(--wh-focus-ring)]",
          "disabled:opacity-45 disabled:pointer-events-none",
          "aria-[invalid=true]:border-danger-border",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

/** Form label. Sentence case; pair with an input via `htmlFor`. */
export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, ...props }, ref) => {
    return (
      <label
        ref={ref}
        className={cn("text-sm font-medium text-fg", "peer-disabled:opacity-45", className)}
        {...props}
      />
    );
  },
);
Label.displayName = "Label";
