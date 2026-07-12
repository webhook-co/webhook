import type { DashboardChartModel } from "@/lib/dashboard-chart";

// A hand-rolled, dependency-free stacked-bar chart of daily delivery outcomes — no chart library on a Workers
// app (per the plan). Pure server render over the chart model: each day is a bar, delivered stacked under
// failed (dead + blocked), scaled to the window's busiest day. Colours come from the sanctioned --wh-chart-*
// palette (which ships light + dark values) via the fill-chart-* utilities, so it themes for free; a legend
// names the colours because colour alone isn't an accessible signal, and the SVG carries an aria summary.

const SLOT = 10; // viewBox units per day column
const BAR_FRAC = 0.64; // bar width as a fraction of its slot (leaves a gutter)
const H = 100; // viewBox height; a day's total maps 0..H against maxTotal

/** Pick ~3 evenly-spaced day labels (first, middle, last) so a 14-day axis doesn't turn to mush. */
function axisTicks(bars: DashboardChartModel["bars"]): { index: number; label: string }[] {
  if (bars.length === 0) return [];
  const idxs = new Set([0, Math.floor((bars.length - 1) / 2), bars.length - 1]);
  return [...idxs]
    .sort((a, b) => a - b)
    .flatMap((index) => {
      const bar = bars[index];
      return bar ? [{ index, label: bar.label }] : [];
    });
}

export function DeliveryChart({ model }: { model: DashboardChartModel }) {
  const { bars, maxTotal, totalDelivered, totalFailed } = model;
  const width = bars.length * SLOT;
  const barW = SLOT * BAR_FRAC;
  const pad = (SLOT - barW) / 2;
  const summary = `Delivery outcomes over the last ${bars.length} days: ${totalDelivered} delivered, ${totalFailed} failed.`;

  return (
    <div className="flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${width} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="h-40 w-full"
      >
        {/* Faint baseline so an all-zero window still reads as a chart, not a void. */}
        <line x1={0} y1={H} x2={width} y2={H} className="stroke-hairline" strokeWidth={0.5} />
        {bars.map((bar, i) => {
          const totalH = (bar.total / maxTotal) * H;
          const deliveredH = (bar.delivered / maxTotal) * H;
          const failedH = (bar.failed / maxTotal) * H;
          const x = i * SLOT + pad;
          return (
            <g key={bar.date}>
              {bar.delivered > 0 && (
                <rect
                  x={x}
                  y={H - deliveredH}
                  width={barW}
                  height={deliveredH}
                  className="fill-chart-2"
                />
              )}
              {bar.failed > 0 && (
                <rect x={x} y={H - totalH} width={barW} height={failedH} className="fill-chart-3" />
              )}
            </g>
          );
        })}
      </svg>

      {/* Axis labels as HTML (the SVG uses preserveAspectRatio="none", which would distort SVG text). */}
      <div className="relative h-4 text-xs text-fg-muted">
        {axisTicks(bars).map((t) => (
          <span
            key={t.index}
            className="absolute -translate-x-1/2 whitespace-nowrap"
            style={{ left: `${((t.index + 0.5) / bars.length) * 100}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-4 text-xs text-fg-secondary">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-[2px] bg-chart-2" aria-hidden />
          Delivered
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-[2px] bg-chart-3" aria-hidden />
          Failed
        </span>
      </div>
    </div>
  );
}
