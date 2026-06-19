import * as React from "react";

import { cn } from "../lib/cn";
import { Button, type ButtonProps } from "./button";

const squareSize = { sm: "size-[34px]", md: "size-[42px]", lg: "size-12" } as const;

export interface IconButtonProps extends ButtonProps {
  /** Required — an icon-only button must carry an accessible name. */
  "aria-label": string;
}

/**
 * A square, icon-only button. Reuses the `Button` variants/colors. Pass a single icon as
 * the child. `aria-label` is required at the type level (an icon-only button needs an
 * accessible name) — give it a meaningful, non-empty value. Control the dimensions via the
 * `size` prop; a `className` size/padding util would override the square.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ size, className, ...props }, ref) => {
    const s = size ?? "md";
    return <Button ref={ref} size={s} className={cn(squareSize[s], "p-0", className)} {...props} />;
  },
);
IconButton.displayName = "IconButton";
