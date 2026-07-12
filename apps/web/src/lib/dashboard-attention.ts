// Pure derivation of the /dashboard "needs attention" panel: failures as resolvable objects, not chart
// pixels. Given a handful of already-loaded signals, produce an ordered list of items (most urgent first),
// each pointing at the page that resolves it. Kept pure so the ordering + copy + pluralization are
// unit-tested without a DB; the panel component just renders whatever this returns (nothing → no panel).

export type AttentionTone = "danger" | "warn";

export interface AttentionItem {
  /** Stable discriminator (also the React key). */
  readonly kind: "past_due" | "paused" | "disabled_destinations" | "dead_deliveries";
  readonly tone: AttentionTone;
  readonly title: string;
  readonly description: string;
  /** Where to go to resolve it. */
  readonly href: string;
}

export interface AttentionInput {
  /** billing subscription is past_due (payment failing). */
  readonly pastDue: boolean;
  /** ingest is paused (event limit reached). */
  readonly paused: boolean;
  /** destinations auto-disabled by persistent delivery failure. */
  readonly disabledDestinationCount: number;
  /** deliveries that exhausted retries (dead) in the shown window. */
  readonly deadCount: number;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Order is severity, not source: money first (past due can suspend the account), then paused capture (you're
 * dropping inbound events right now), then auto-disabled destinations (outbound is silently stopped), then
 * dead deliveries (already given up, but recoverable via replay). Each links to its resolving page.
 */
export function deriveAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (input.pastDue) {
    items.push({
      kind: "past_due",
      tone: "danger",
      title: "Payment past due",
      description: "We're retrying your card. Update it to keep your plan active.",
      href: "/billing",
    });
  }

  if (input.paused) {
    items.push({
      kind: "paused",
      tone: "warn",
      title: "Capture is paused",
      description:
        "You've hit your event limit for this period. New events aren't captured until it resets or your limit is raised.",
      href: "/usage",
    });
  }

  if (input.disabledDestinationCount > 0) {
    const n = input.disabledDestinationCount;
    items.push({
      kind: "disabled_destinations",
      tone: "danger",
      title: `${n} ${plural(n, "destination", "destinations")} auto-disabled`,
      description: `We stopped delivering after repeated failures. Fix the ${plural(n, "endpoint", "endpoints")} and re-enable ${plural(n, "it", "them")}.`,
      href: "/destinations",
    });
  }

  if (input.deadCount > 0) {
    const n = input.deadCount;
    items.push({
      kind: "dead_deliveries",
      tone: "warn",
      title: `${n} ${plural(n, "delivery", "deliveries")} gave up`,
      description: `${plural(n, "It", "They")} exhausted every retry. Review and replay when the destination is back.`,
      href: "/deliveries?status=dead",
    });
  }

  return items;
}
