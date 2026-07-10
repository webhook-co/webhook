import { Banner } from "@webhook-co/ui";
import type { Metadata } from "next";

import { loadUsage } from "@/server/usage";
import { verifySession } from "@/server/session";
import type { UsageSummary } from "@webhook-co/shared";

// Billing (current plan, upgrade, portal) lives in its own dedicated /billing section now — this page is
// the usage meter only.

export const metadata: Metadata = {
  title: "Usage · webhook.co",
};

const fmtCount = (n: number): string => n.toLocaleString("en-US");
const fmtDate = (d: Date): string =>
  d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });

export default async function UsagePage() {
  const session = await verifySession();
  const result = await loadUsage(session.orgId);

  return (
    <div className="mx-auto flex max-w-[860px] flex-col gap-8 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Usage</h1>
        {/* Disclosure (constitution: the billable unit is stated up front). Single-dimension, no
            per-step counters — so the number here is the whole story. */}
        <p className="leading-snug text-fg-secondary">
          Metering is single-dimension: one event is a captured request to an endpoint, <em>or</em>{" "}
          one delivery to a destination. Retries never count. You&apos;re billed on events — no
          per-step or per-feature charges, and every feature is on every plan.
        </p>
      </div>

      {result.status === "error" ? (
        <Banner tone="danger">We couldn&apos;t load your usage. Refresh to try again.</Banner>
      ) : (
        <UsageCard usage={result.usage} />
      )}
    </div>
  );
}

/** The usage meter: events used vs the org's cap, the pause state, and the billable-unit disclosure. */
function UsageCard({ usage }: { usage: UsageSummary }) {
  const { events, eventCap, pausePolicy, paused, periodStart, periodEnd, capKind } = usage;
  // The Free tier's ONE-TIME allowance: no periodEnd, never resets — so we must not offer a reset date
  // or tell a paused org to "wait for the next period". The way out is upgrading.
  const lifetime = capKind === "lifetime";
  // The TRUE percentage (uncapped) is shown as text so an over-cap 'allow' org reads its real overage
  // (e.g. 150%) — matching `wbhk usage`. The BAR is a fill gauge, so its width + aria clamp to 100%.
  const pct = eventCap && eventCap > 0 ? Math.round((events / eventCap) * 100) : null;
  const barPct = pct === null ? 0 : Math.min(100, pct);
  // Meter fill tone tracks headroom: comfortable → ok, ≥80% → warn (approaching the cap).
  const meterTone = pct !== null && pct >= 80 ? "bg-warn" : "bg-ok";

  return (
    <div className="flex flex-col gap-5">
      {paused &&
        (lifetime ? (
          <Banner tone="warn">
            Capture is paused — you&apos;ve used your one-time free allowance. It doesn&apos;t
            reset; upgrade to resume capturing.
          </Banner>
        ) : (
          <Banner tone="warn">
            Capture is paused — you&apos;ve reached your event limit for this period. It resumes at
            the start of the next period, or when your limit is raised.
          </Banner>
        ))}

      <div className="flex flex-col gap-6 rounded-card border border-hairline bg-surface p-6">
        <div className="flex items-baseline justify-between">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-fg-secondary">
              {lifetime ? "One-time allowance" : "This period"}
            </span>
            <span className="text-sm text-fg">
              {lifetime || periodEnd === null
                ? `Since ${fmtDate(periodStart)} · does not reset`
                : `${fmtDate(periodStart)} — ${fmtDate(periodEnd)}`}
            </span>
          </div>
          <span className={`text-sm ${paused ? "text-warn" : "text-ok"}`}>
            {paused ? "paused" : "active"}
          </span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-heading text-fg">
              {fmtCount(events)}
            </span>
            <span className="text-fg-secondary">
              {eventCap === null ? "events" : `of ${fmtCount(eventCap)} events`}
              {pct !== null ? ` · ${pct}%` : ""}
            </span>
          </div>
          {pct !== null && (
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
              role="progressbar"
              aria-valuenow={barPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Events used this period"
            >
              <div className={`h-full rounded-full ${meterTone}`} style={{ width: `${barPct}%` }} />
            </div>
          )}
        </div>

        <p className="text-sm text-fg-secondary">
          {eventCap === null
            ? "No event limit is set for this org."
            : pausePolicy === "pause"
              ? "At your limit, capture pauses — you're never billed past it."
              : "Events past your included volume are billed as overage."}
        </p>
      </div>
    </div>
  );
}
