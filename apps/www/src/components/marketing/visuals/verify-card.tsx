import { cn } from "@webhook-co/ui";
import { ShieldCheck } from "lucide-react";

const FAILURES = [
  {
    provider: "github",
    event: "issues.opened",
    code: "raw_body_modified",
    why: "A proxy or framework re-serialized the body before verification.",
  },
  {
    provider: "shopify",
    event: "orders.create",
    code: "timestamp_too_old",
    why: "The request fell outside the replay window.",
  },
  {
    provider: "stripe",
    event: "invoice.paid",
    code: "wrong_secret_test_vs_live",
    why: "The signature is valid, just against the other environment's secret.",
  },
];

/**
 * The verification visual: named failure reasons. Each row briefly flashes a danger tint in
 * sequence (the `.verify-row` loop in `marketing.css`); the ✕ chip + cause are static and legible
 * with motion off.
 */
export function VerifyCard() {
  return (
    <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-2">
      {FAILURES.map((failure, index) => (
        <div
          key={failure.code}
          className={cn(
            "verify-row flex flex-col gap-1 px-5 py-4",
            index > 0 && "border-t border-hairline",
          )}
        >
          <span className="inline-flex flex-wrap items-center gap-[9px] font-mono text-[13px] font-medium text-fg">
            <span
              className="grid h-[17px] w-[17px] place-items-center rounded-pill border border-danger-border bg-danger-bg text-[10px] text-danger"
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
          <span className="pl-[26px] text-[13px] text-fg-muted">{failure.why}</span>
        </div>
      ))}
      <div className="flex items-center gap-[9px] border-t border-hairline bg-surface-page px-5 py-4 text-[13px] text-fg-secondary">
        <ShieldCheck className="h-4 w-4 text-ok" aria-hidden="true" />
        Each failure names its cause, with the fix attached.
      </div>
    </div>
  );
}
