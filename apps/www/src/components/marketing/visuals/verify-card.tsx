import { cn } from "@webhook-co/ui";
import { ShieldCheck } from "lucide-react";

/**
 * The failure codes shown here are REAL: each one is a member of the shipped verification failure
 * union (`VerificationFailureSchema` in `@webhook-co/webhooks-spec`) — the same UPPERCASE string the
 * dashboard, the CLI and the API hand back. `verify-card.test.ts` pins them to that union, so an
 * invented code can't reach the page and a renamed one can't linger.
 *
 * The causes are the same diagnoses the product writes: a re-serialized body, a stale timestamp, a
 * secret that doesn't match. Marketing copy, product truth — same sentence.
 */
export const VERIFY_FAILURES = [
  {
    provider: "github",
    event: "issues.opened",
    code: "RAW_BODY_MODIFIED",
    why: "The body was modified in transit — usually a proxy or framework re-encoding the JSON.",
  },
  {
    provider: "shopify",
    event: "orders.create",
    code: "TIMESTAMP_TOO_OLD",
    why: "The signature timestamp fell outside the replay window.",
  },
  {
    provider: "stripe",
    event: "invoice.paid",
    code: "WRONG_SECRET",
    why: "The signature didn't match — the configured secret is likely the wrong one.",
  },
] as const;

/**
 * The verification visual: named failure reasons. Each row briefly flashes a danger tint in
 * sequence (the `.verify-row` loop in `marketing.css`); the ✕ chip + cause are static and legible
 * with motion off.
 */
export function VerifyCard() {
  return (
    <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-2">
      <ul aria-label="Verification failures">
        {VERIFY_FAILURES.map((failure, index) => (
          <li
            key={failure.code}
            className={cn(
              "verify-row flex flex-col gap-1 px-5 py-4",
              index > 0 && "border-t border-hairline",
            )}
          >
            <span className="inline-flex flex-wrap items-center gap-[0.5625rem] font-mono text-sm font-medium text-fg">
              <span
                className="grid h-[1.0625rem] w-[1.0625rem] place-items-center rounded-pill border border-danger-border bg-danger-bg text-[0.625rem] text-danger"
                aria-hidden="true"
              >
                ✕
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="text-fg-secondary">
                  {failure.provider} · {failure.event}
                </span>
                <span className="text-fg-faint" aria-hidden="true">
                  —
                </span>
                {failure.code}
              </span>
            </span>
            <span className="pl-[1.625rem] text-sm text-fg-muted">{failure.why}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-[0.5625rem] border-t border-hairline bg-surface-page px-5 py-4 text-sm text-fg-secondary">
        <ShieldCheck className="h-4 w-4 text-ok" aria-hidden="true" />
        Each failure names its cause, with the fix attached.
      </div>
    </div>
  );
}
