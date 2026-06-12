import * as React from "react";

import { cn } from "../lib/cn";
import { Badge, type BadgeProps } from "./badge";

/** Tones available to status indicators — the functional-color set plus neutral. */
export type StatusTone = "ok" | "warn" | "danger" | "info" | "neutral";

/**
 * Delivery lifecycle states surfaced across the product. Kept here next to the tone
 * mapping so every surface (web/CLI/API/MCP) agrees on which color a state earns.
 */
export type DeliveryStatus =
  | "delivered"
  | "pending"
  | "retrying"
  | "failed"
  | "replayed"
  | "disabled";

const TONE_BY_STATUS: Record<DeliveryStatus, StatusTone> = {
  delivered: "ok",
  pending: "neutral",
  retrying: "warn",
  failed: "danger",
  replayed: "info",
  disabled: "neutral",
};

/**
 * Map a delivery status to its functional tone. The single source of truth for "what
 * color does this state earn" — green/amber/red/blue carry meaning, nothing else does.
 */
export function deliveryStatusTone(status: DeliveryStatus): StatusTone {
  return TONE_BY_STATUS[status];
}

const DOT_BY_TONE: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-fg-faint",
};

export interface StatusPillProps extends Omit<BadgeProps, "tone" | "children"> {
  /** The tone to render. Provide this or `status`. */
  tone?: StatusTone;
  /** A delivery status; its tone is derived. Overrides `tone` when set. */
  status?: DeliveryStatus;
  /** Show a leading colored dot. Defaults to true. */
  dot?: boolean;
  /** Visible label. Defaults to the `status` value when provided. */
  children?: React.ReactNode;
}

/**
 * A status chip with an optional leading dot. Pass a `status` to derive both tone and
 * a default label, or a `tone` directly for ad-hoc indicators.
 */
export function StatusPill({
  tone,
  status,
  dot = true,
  children,
  className,
  ...props
}: StatusPillProps) {
  const resolvedTone: StatusTone = status ? deliveryStatusTone(status) : (tone ?? "neutral");
  const label = children ?? status;

  return (
    <Badge tone={resolvedTone} className={className} {...props}>
      {dot ? (
        <span
          aria-hidden="true"
          className={cn("size-1.5 rounded-full", DOT_BY_TONE[resolvedTone])}
        />
      ) : null}
      {label}
    </Badge>
  );
}
