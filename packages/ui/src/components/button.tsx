import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";
import { Spinner } from "./spinner";

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
        sm: "h-[2.125rem] px-3.5 text-sm",
        md: "h-[2.625rem] px-5 text-base",
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
  /**
   * The action this button started is still running.
   *
   * Renders the spinner IN PLACE OF {@link icon}, marks the button `aria-busy`, and disables it — one prop,
   * because those three were always meant to travel together and a call site that hand-rolls them gets at
   * least one wrong. (Before this, the product had two `useTransition` call sites and ZERO `useFormStatus`;
   * "pending" was expressed, if at all, as a bare `disabled` — which tells a user a control is *unavailable*,
   * not that their click was heard and is being worked on. That is the difference between "broken" and
   * "working", and we were shipping the first one.)
   *
   * The LABEL DELIBERATELY STAYS. Swapping it for a spinner is what makes buttons jump: the element resizes
   * mid-click, the row reflows, and you get a flicker of movement carrying no information. Keeping the text
   * holds the width stable and lets the user still read what they asked for.
   */
  loading?: boolean;
  /**
   * A leading icon — and the slot the spinner takes over while {@link loading}.
   *
   * It is a PROP rather than just the first child for exactly that reason: if the icon lived in `children`,
   * a loading button would render the spinner NEXT TO it (two glyphs, and the button growing wider mid-click),
   * and avoiding that would be left to every call site to remember. Here the swap is structural — a loading
   * button cannot show its idle icon, because there is only one slot.
   */
  icon?: React.ReactNode;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      type,
      loading = false,
      icon,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";

    // `asChild` hands rendering to the CALLER's element (an anchor, a Radix trigger). Slot takes exactly one
    // child, so injecting a spinner beside it would throw — and a link has no pending state to show anyway,
    // because it navigates. So under `asChild` the extras collapse and `children` passes through untouched.
    if (asChild) {
      return (
        <Comp
          ref={ref}
          className={cn(buttonVariants({ variant, size }), className)}
          aria-busy={loading || undefined}
          {...props}
        >
          {children}
        </Comp>
      );
    }

    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        // Native buttons default to "submit"; be explicit.
        type={type ?? "button"}
        // `||`, NOT `??`. A loading button must never be clickable — a double-submitted invite, key mint or
        // delete is a real bug, not a cosmetic one — and `disabled ?? loading` would leave an explicit
        // `disabled={false}` clickable WHILE loading, which is precisely the case worth being paranoid about.
        disabled={disabled || loading}
        // Announce the state, don't merely remove the control. A disabled button with no `aria-busy` tells a
        // screen-reader user the action is unavailable; `aria-busy` tells them it is under way.
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? (
          <Spinner
            size="sm"
            // Decorative HERE: `aria-busy` on the button already carries the meaning, and a second live region
            // would announce "Loading" over the label the user is trying to hear.
            aria-hidden="true"
            label=""
            className="size-4"
          />
        ) : (
          icon
        )}
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";
