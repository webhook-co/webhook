"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";

import { Button, type ButtonProps } from "./button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

export interface ConfirmDialogProps {
  /** The control that opens the modal — rendered as the Radix trigger (`asChild`). Give it no `…`: the
   *  modal now carries the "are you sure" weight, so the trigger is a plain verb ("Delete account"). */
  readonly trigger: React.ReactNode;
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /**
   * The action the confirm button submits to. This is a real `<form action>` (not an onClick), so a server
   * action gets its FormData — including the typed-confirmation field below — and the server stays the
   * authority (it re-checks the acknowledgement; the disabled button is only a client convenience).
   */
  readonly formAction: (formData: FormData) => void | Promise<void>;
  readonly confirmLabel: React.ReactNode;
  readonly cancelLabel?: React.ReactNode;
  /** The confirm button's variant. Destructive by default — this primitive exists for danger-zone actions. */
  readonly confirmTone?: ButtonProps["variant"];
  /**
   * When set, the user must type this EXACT string before confirm enables, and the typed value is submitted
   * under {@link confirmFieldName} so the server can re-verify it. Omit for a plain one-click confirmation.
   */
  readonly confirmText?: string;
  /** The form field the typed confirmation posts under. Defaults to `confirm` (what the delete actions read). */
  readonly confirmFieldName?: string;
}

/** The submit button, split out so `useFormStatus` can read the enclosing form's pending state (it reads
 *  context the parent `<form>` provides, so it must be a child of the form, not the form's own component). */
function ConfirmSubmit({
  disabled,
  variant,
  children,
}: {
  readonly disabled: boolean;
  readonly variant: ButtonProps["variant"];
  readonly children: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} loading={pending} disabled={disabled || pending}>
      {children}
    </Button>
  );
}

/**
 * A destructive-action confirmation modal: a trigger opens a Radix dialog whose confirm button submits a
 * (server) action. Optionally gates confirm behind typing an exact word (e.g. `DELETE`) that rides along in
 * the FormData for the server to re-check. Replaces the hand-rolled inline "type DELETE" reveals and the
 * one-off `Dialog` + danger-`Button` confirmations scattered across the dashboard.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  formAction,
  confirmLabel,
  cancelLabel = "Cancel",
  confirmTone = "danger",
  confirmText,
  confirmFieldName = "confirm",
}: ConfirmDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const inputId = React.useId();

  const needsTyped = confirmText != null && confirmText.length > 0;
  const confirmEnabled = !needsTyped || typed === confirmText;

  function onOpenChange(next: boolean) {
    setOpen(next);
    // Reset the typed confirmation on close so a reopened modal starts clean — no stale "DELETE" that would
    // let a second open confirm with one click.
    if (!next) setTyped("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-4">
          {needsTyped ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={inputId} className="text-sm text-fg-secondary">
                Type <span className="font-mono font-semibold text-fg">{confirmText}</span> to
                confirm.
              </label>
              <input
                id={inputId}
                name={confirmFieldName}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="w-full rounded-control border border-hairline bg-surface px-3 py-2 font-mono text-sm text-fg outline-none focus-visible:shadow-[var(--wh-focus-ring)]"
              />
            </div>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {cancelLabel}
              </Button>
            </DialogClose>
            <ConfirmSubmit variant={confirmTone} disabled={!confirmEnabled}>
              {confirmLabel}
            </ConfirmSubmit>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
