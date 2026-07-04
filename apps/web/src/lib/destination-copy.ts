import type { StatusTone } from "@webhook-co/ui";

/**
 * The dashboard's honest, user-facing rendering of a replay destination's state, and of a structural
 * URL-validation refusal. The single source of "what tone + words does this state earn" for the
 * destinations surface (mirrors `delivery-copy.ts`). Tone carries meaning (green ok / amber warn /
 * neutral); the label is plain product copy; `hint` adds a truthful one-liner where a state has a reason
 * a user needs. We never imply more than is true — a destination is `disabled` because the delivery engine
 * auto-disabled it after repeated failures, and a rejected URL is refused because it isn't an allowed
 * public https target, NOT because it is "malicious".
 */

/** The display status a destination row earns, derived from its record `status` + `disabledAt`. */
export type DestinationDisplayStatus = "active" | "disabled" | "revoked";

/**
 * Collapse a destination record's `status` (`active`/`revoked`) + `disabledAt` into a single display
 * status. A live record with `disabledAt` set was auto-disabled by the engine (consecutive failures) and
 * is re-enable-able; a revoked record is soft-deleted.
 */
export function destinationDisplayStatus(d: {
  readonly status: "active" | "revoked";
  readonly disabledAt: Date | null;
}): DestinationDisplayStatus {
  if (d.status === "revoked") return "revoked";
  return d.disabledAt === null ? "active" : "disabled";
}

export interface DestinationCopy {
  readonly tone: StatusTone;
  readonly label: string;
  readonly hint?: string;
}

const COPY: Record<DestinationDisplayStatus, DestinationCopy> = {
  active: { tone: "ok", label: "Active" },
  disabled: {
    tone: "warn",
    label: "Disabled",
    hint: "Auto-disabled after repeated delivery failures — enable it to resume deliveries.",
  },
  revoked: { tone: "neutral", label: "Revoked" },
};

/** Map a display status to its functional tone + plain-language label/hint. */
export function destinationCopy(s: DestinationDisplayStatus): DestinationCopy {
  return COPY[s];
}

/**
 * Turn a structural SSRF-validator failure `reason` (`canonicalizeAndValidateUrl`) into an honest,
 * plain-language inline error. The validator is structural-only (no DNS), so this copy explains what an
 * allowed target looks like — it never accuses the URL of being an attack. Unknown/parse-level reasons
 * fall back to a generic "enter a valid https:// URL".
 */
export function destinationUrlError(reason: string): string {
  switch (reason) {
    case "not_https":
      return "Use an https:// URL.";
    case "has_userinfo":
      return "Remove the username or password from the URL.";
    case "disallowed_port":
      return "That port isn't allowed — use the default https port.";
    case "ip_literal_host":
      return "Enter a public hostname, not an IP address.";
    case "single_label_host":
      return "Enter a full domain name (for example, api.example.com).";
    default:
      return "Enter a valid https:// URL.";
  }
}
