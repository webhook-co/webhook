import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * A popover built on Radix — focus-managed, dismissable (Escape / outside-click), and rendered in a
 * portal so it escapes overflow clipping. Unlike `DropdownMenu`, it does NOT impose menu semantics
 * (roving focus, typeahead, arrow-key item navigation), so it's the right surface for arbitrary
 * interactive content: a searchable multi-select, a calendar, a form. Compose `Popover` +
 * `PopoverTrigger` + `PopoverContent`.
 */
export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 6, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-control border border-hairline bg-surface p-1 text-fg shadow-3",
        "outline-none",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";
