"use client";

import { Button, type ButtonProps } from "@webhook-co/ui";
import { useFormStatus } from "react-dom";

/**
 * A submit button that shows a pending state while ITS OWN form's action is in flight — no `useState`, no
 * transition, no wiring at the call site.
 *
 * `useFormStatus` reads the pending state of the nearest enclosing `<form>`, which is exactly the shape of
 * every "type DELETE, then submit" and "rename, then save" form in the dashboard. Before this, those forms
 * submitted a SERVER ACTION with no feedback at all: the button stayed idle while a cross-service call ran, so
 * a slow delete looked like a dead click and got clicked again — and "delete my account" is not an action you
 * want fired twice.
 *
 * It MUST live in a child component of the form, not the form itself: `useFormStatus` reads context the parent
 * `<form>` provides, so a hook called in the same component that renders the form sees nothing. That is the one
 * sharp edge, and it is why this is its own component.
 */
export function SubmitButton({ children, disabled, ...props }: ButtonProps) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" loading={pending} disabled={disabled || pending} {...props}>
      {children}
    </Button>
  );
}
