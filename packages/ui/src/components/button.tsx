import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * The control vocabulary: a solid inverse-ink `primary` paired with a hairline
 * `secondary`, a text-only `ghost`, and a `danger` — the single case where a button
 * carries color, reserved for destructive actions. No gradients, no glow, no scale or
 * ripple on interaction: hover is a tint shift, press is a 0.5px nudge, focus is the
 * always-visible ring.
 */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-control font-sans font-medium tracking-tight",
    "border border-transparent cursor-pointer select-none",
    "transition-[background-color,box-shadow,transform] duration-[var(--wh-dur-instant)] ease-[var(--wh-ease-swift)]",
    "active:translate-y-[0.5px]",
    "outline-none focus-visible:shadow-[var(--wh-focus-ring)]",
    "disabled:opacity-45 disabled:pointer-events-none",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-surface-inverse text-fg-on-inverse shadow-2 [box-shadow:var(--wh-shadow-2),inset_0_1px_0_rgb(255_255_255/0.14)] hover:bg-surface-inverse/90",
        secondary: "bg-surface text-fg border-strong shadow-1 hover:bg-surface-sunken",
        ghost: "bg-transparent text-fg-secondary hover:bg-surface-sunken hover:text-fg",
        danger: "bg-danger text-white shadow-1 hover:bg-danger/90",
      },
      size: {
        sm: "h-[34px] px-3.5 text-sm",
        md: "h-[42px] px-5 text-base",
        lg: "h-12 px-6 text-md",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Render as the child element (e.g. an anchor) while keeping button styling. */
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        // Native buttons default to "submit"; be explicit unless composing.
        type={asChild ? undefined : (type ?? "button")}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
