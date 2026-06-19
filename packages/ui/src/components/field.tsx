import * as React from "react";

import { cn } from "../lib/cn";
import { Input, Label, type InputProps } from "./input";

export interface FieldProps extends InputProps {
  /** The field label (sentence case). */
  label: React.ReactNode;
  /** Optional helper text shown below the control. */
  hint?: React.ReactNode;
  /** Optional error message; sets the invalid state and describes the control. */
  error?: React.ReactNode;
  /** Class for the field wrapper (the control still takes `className`). */
  fieldClassName?: string;
}

/**
 * A labelled form field — Label + Input + optional hint/error — with the accessibility
 * wiring done for you: a generated id links the label to the control, an error sets
 * `aria-invalid` + the danger border (no red fill), and the hint/error are linked via
 * `aria-describedby`. Composes the design-system `Input` + `Label`.
 */
export const Field = React.forwardRef<HTMLInputElement, FieldProps>(
  (
    {
      label,
      hint,
      error,
      id,
      fieldClassName,
      className,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      ...props
    },
    ref,
  ) => {
    const reactId = React.useId();
    const fieldId = id ?? reactId;
    const hintId = hint ? `${fieldId}-hint` : undefined;
    const errorId = error ? `${fieldId}-error` : undefined;
    const describedBy = [ariaDescribedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;

    return (
      <div className={cn("flex flex-col gap-1.5", fieldClassName)}>
        <Label htmlFor={fieldId}>{label}</Label>
        <Input
          ref={ref}
          id={fieldId}
          aria-invalid={error ? true : ariaInvalid}
          aria-describedby={describedBy}
          className={className}
          {...props}
        />
        {hint ? (
          <p id={hintId} className="text-sm text-fg-faint">
            {hint}
          </p>
        ) : null}
        {error ? (
          // role="alert" so a validation error that appears after submit is announced,
          // even when focus is elsewhere.
          <p id={errorId} role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = "Field";
