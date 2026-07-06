import type { DeliveryStatus, VerificationState } from "@webhook-co/shared";
import type { StatusTone } from "@webhook-co/ui";

/**
 * The dashboard's honest, user-facing rendering of a delivery's lifecycle state — the single source of
 * "what tone + words does this state earn" for the deliveries surface. Mirrors the `verification-copy.ts`
 * shape. Tone carries meaning (green ok / red danger / neutral); the label is plain product copy (never the
 * raw enum); `hint` adds a truthful one-liner where the state has a reason a user needs (a retry clock, an
 * SSRF refusal, a dead-letter, a removed destination). We never imply more than is true — a `blocked`
 * delivery was refused because the URL resolved to a private address, not because it was "malicious".
 */
export interface DeliveryCopy {
  readonly tone: StatusTone;
  readonly label: string;
  readonly hint?: string;
}

export interface DeliveryCopyOptions {
  /** When the delivery is next due — drives the `pending` retry hint. Null/absent = no live retry clock. */
  readonly nextRetryAt?: Date | null;
  /** Injectable "now" for deterministic relative-time hints (tests). Defaults to the real clock. */
  readonly now?: Date;
  /** The SOURCE event's verification state — disambiguates a `blocked` row (ADR-0103): a verification
   *  failure (`failed`) blocks for a very different reason than the SSRF guard, so its hint must differ. */
  readonly sourceVerificationState?: VerificationState;
}

/** A coarse, honest relative-time string ("in 4m" / "in 2h"); undefined once the due time has passed. */
function retryHint(nextRetryAt: Date, now: Date): string | undefined {
  const ms = nextRetryAt.getTime() - now.getTime();
  if (ms <= 0) return undefined; // due now / overdue — the row is (re)claiming, don't show a stale clock
  const minutes = Math.ceil(ms / 60_000); // round up so a sub-minute wait never reads "in 0m"
  if (minutes < 60) return `Retrying in ${minutes}m`;
  return `Retrying in ${Math.round(minutes / 60)}h`;
}

// The static states — pending is derived separately since its label/hint depend on the retry clock.
const STATIC_COPY: Record<Exclude<DeliveryStatus, "pending">, DeliveryCopy> = {
  delivered: { tone: "ok", label: "Delivered" },
  queued: { tone: "neutral", label: "Queued" },
  failed: { tone: "danger", label: "Failed" },
  blocked: {
    tone: "danger",
    // The engine sets `blocked` from two guard paths — a structural URL reject AND a resolves-to-private
    // address refusal — so the hint stays true to both; the detail view's per-row `error` carries the exact
    // reason. We never imply more than is true (e.g. that the URL is "malicious").
    label: "Blocked",
    hint: "Refused by the delivery guard — the destination isn't allowed",
  },
  dead: { tone: "danger", label: "Undelivered", hint: "Gave up after the last retry" },
  cancelled: {
    tone: "neutral",
    label: "Cancelled",
    hint: "The destination was removed before this could be delivered",
  },
  forwarded: { tone: "neutral", label: "Forwarded" },
};

export function deliveryCopy(status: DeliveryStatus, opts: DeliveryCopyOptions = {}): DeliveryCopy {
  if (status === "pending") {
    const now = opts.now ?? new Date();
    const hint = opts.nextRetryAt ? retryHint(opts.nextRetryAt, now) : undefined;
    // A future retry clock reads as "Retrying"; otherwise the row is actively in flight ("In progress").
    return hint
      ? { tone: "neutral", label: "Retrying", hint }
      : { tone: "neutral", label: "In progress" };
  }
  // A `blocked` status covers two very different refusals: the SSRF delivery guard (the default hint) AND a
  // verification-failure block (ADR-0103 — the source event's signature was checked and rejected, so we
  // never re-sign/forward it). Branch on the un-forgeable source state so the hint matches the raw `error`.
  if (status === "blocked" && opts.sourceVerificationState === "failed") {
    return {
      tone: "danger",
      label: "Blocked",
      hint: "Not delivered — the source event's signature was rejected",
    };
  }
  return STATIC_COPY[status];
}

/** Was this delivery signed with the destination's secret? Signed only when the source was verified —
 *  an unverified (`unattempted`) event is forwarded UNSIGNED (ADR-0103), so a downstream that requires a
 *  webhook.co signature will reject it. Shown as a small indicator on the deliveries list + detail. */
export function deliverySignatureCopy(sourceState: VerificationState): DeliveryCopy {
  const signed = sourceState === "verified" || sourceState === "authenticated";
  return signed
    ? { tone: "ok", label: "Signed", hint: "Signed with your destination's secret" }
    : {
        tone: "neutral",
        label: "Unsigned",
        hint: "Delivered without a signature — the source event wasn't verified",
      };
}
