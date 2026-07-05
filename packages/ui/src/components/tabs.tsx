import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

import { cn } from "../lib/cn";

/**
 * Tabs built on Radix — keyboard-navigable (arrow keys + Home/End), ARIA `tablist`/`tab`/`tabpanel`
 * wired for free, and inactive panels unmounted by default. A quiet segmented control: the list is a
 * sunken hairline track, the active trigger lifts to the surface. Compose `Tabs` + `TabsList` +
 * `TabsTrigger` (one per section) + `TabsContent` (matched by `value`).
 */
export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1 rounded-control border border-hairline bg-surface-sunken p-1",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-control px-3 py-1 text-sm font-medium text-fg-secondary",
      "transition-colors hover:text-fg",
      "data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-1",
      "cursor-pointer outline-none focus-visible:shadow-[var(--wh-focus-ring)]",
      "disabled:pointer-events-none disabled:opacity-45",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn("outline-none focus-visible:shadow-[var(--wh-focus-ring)]", className)}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";
