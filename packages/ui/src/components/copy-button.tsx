"use client";

import * as React from "react";

import { Button, type ButtonProps } from "./button";

export interface CopyButtonProps extends Omit<
  ButtonProps,
  "value" | "children" | "onClick" | "onCopy"
> {
  /** The text written to the clipboard on click. */
  value: string;
  /** Resting label (default "Copy"). */
  label?: string;
  /** Label shown briefly after a successful copy (default "Copied"). */
  copiedLabel?: string;
  /** Called with the copied value after it reaches the clipboard. */
  onCopy?: (value: string) => void;
}

const RESET_MS = 2000;

/**
 * A button that copies a string to the clipboard, swaps to a confirmation for ~2s, and
 * announces the result through a polite live region. Built for the one-time key reveal —
 * pass the secret as `value`; the component never renders it.
 */
export const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ value, label = "Copy", copiedLabel = "Copied", onCopy, variant, ...props }, ref) => {
    const [copied, setCopied] = React.useState(false);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    React.useEffect(() => () => clearTimeout(timeoutRef.current), []);

    async function handleCopy() {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        // The Clipboard API rejects in an insecure context or when permission is denied.
        // Don't claim success: the absence of the confirmation is the signal to the user.
        return;
      }
      setCopied(true);
      onCopy?.(value);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), RESET_MS);
    }

    return (
      <>
        <Button
          ref={ref}
          type="button"
          variant={variant ?? "secondary"}
          onClick={handleCopy}
          {...props}
        >
          {copied ? (
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="m5 12 5 5L19 7"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect
                x="9"
                y="9"
                width="11"
                height="11"
                rx="2.5"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
          {copied ? copiedLabel : label}
        </Button>
        {/* Live region announces the copy to assistive tech without re-reading the button. */}
        <span role="status" aria-live="polite" className="sr-only">
          {copied ? copiedLabel : ""}
        </span>
      </>
    );
  },
);
CopyButton.displayName = "CopyButton";
