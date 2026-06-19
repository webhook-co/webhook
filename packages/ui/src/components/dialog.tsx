import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as React from "react";

import { cn } from "../lib/cn";
import { IconButton } from "./icon-button";

/**
 * A modal dialog built on Radix — focus is trapped while open, Escape and an outside
 * click dismiss it, and the title/description are wired to the dialog's accessible
 * name/description. Compose `DialogTrigger` + `DialogContent` (with `DialogHeader` /
 * `DialogTitle` / `DialogDescription` / `DialogFooter`); `DialogContent` ships a
 * top-right close affordance unless `hideCloseButton` is set.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    // A theme-independent scrim: the same dim sits behind the modal in light and dark.
    className={cn("fixed inset-0 z-50 bg-[rgb(9_11_16/0.55)]", className)}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

export interface DialogContentProps extends React.ComponentPropsWithoutRef<
  typeof DialogPrimitive.Content
> {
  /** Drop the built-in top-right close button (supply your own `DialogClose`). */
  hideCloseButton?: boolean;
}

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, hideCloseButton = false, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5",
        "rounded-modal border border-hairline bg-surface p-6 text-fg shadow-3",
        "outline-none focus-visible:shadow-[var(--wh-focus-ring)]",
        className,
      )}
      {...props}
    >
      {children}
      {hideCloseButton ? null : (
        <DialogPrimitive.Close asChild>
          <IconButton
            aria-label="Close"
            variant="ghost"
            size="sm"
            className="absolute right-3 top-3"
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-4">
              <path
                d="m6 6 12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </IconButton>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5 pr-8", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold tracking-tight text-fg", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm leading-body text-fg-secondary", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";
