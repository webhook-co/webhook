import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "../lib/cn";
import { IconButton } from "./icon-button";

/**
 * An inline message box for form/action feedback. Carries one of the functional tones
 * (`info`/`ok`/`warn`/`danger`) — never decoration — with a matching leading glyph. The
 * `danger` tone announces assertively (`role="alert"`); the rest announce politely
 * (`role="status"`). Pass `onDismiss` to add a dismiss control.
 */
export const bannerVariants = cva(["flex gap-3 rounded-card border p-4 text-sm"], {
  variants: {
    tone: {
      neutral: "border-hairline bg-surface-sunken text-fg-secondary",
      ok: "border-ok-border bg-ok-bg text-ok",
      warn: "border-warn-border bg-warn-bg text-warn",
      danger: "border-danger-border bg-danger-bg text-danger",
      info: "border-info-border bg-info-bg text-info",
    },
  },
  defaultVariants: {
    tone: "info",
  },
});

type Tone = NonNullable<VariantProps<typeof bannerVariants>["tone"]>;

function ToneIcon({ tone }: { tone: Tone }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none" as const,
    "aria-hidden": true,
    className: "mt-px size-[18px] shrink-0",
  };
  if (tone === "ok") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path
          d="m8.5 12 2.5 2.5L15.5 9"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (tone === "warn") {
    return (
      <svg {...common}>
        <path
          d="M12 4 2.5 20h19L12 4Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (tone === "danger") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path d="m9 9 6 6M15 9l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  // info / neutral
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 11v5M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export interface BannerProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">, VariantProps<typeof bannerVariants> {
  /** Optional bold lead-in above the message. */
  title?: React.ReactNode;
  /** Render a dismiss control that calls this on click. */
  onDismiss?: () => void;
}

export const Banner = React.forwardRef<HTMLDivElement, BannerProps>(
  ({ className, tone, title, onDismiss, children, ...props }, ref) => {
    const resolvedTone: Tone = tone ?? "info";
    return (
      <div
        ref={ref}
        role={resolvedTone === "danger" ? "alert" : "status"}
        className={cn(bannerVariants({ tone }), className)}
        {...props}
      >
        <ToneIcon tone={resolvedTone} />
        <div className="flex flex-1 flex-col gap-0.5">
          {title ? <p className="font-medium">{title}</p> : null}
          <div className="leading-body">{children}</div>
        </div>
        {onDismiss ? (
          <IconButton
            aria-label="Dismiss"
            variant="ghost"
            size="sm"
            className="-my-1 -mr-1 shrink-0 text-current"
            onClick={onDismiss}
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
        ) : null}
      </div>
    );
  },
);
Banner.displayName = "Banner";
