"use client";

import { cn } from "@webhook-co/ui";
import { Pause, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { SurfaceCompanion } from "@/components/marketing/surfaces/surface-companion";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { SectionHeading } from "@/components/ui/section-heading";
import { container, focusRing, sectionPad } from "@/lib/styles";
import { FAIL_REASON_LABEL, type SigStatus, type StreamRow } from "./stream-data";
import { useLiveStream } from "./use-live-stream";

/**
 * The live-inspector stage — the homepage's signature element. An illustrative stream of webhook
 * events arriving, getting signature-checked, and staying ready to replay. The cycling logic lives in
 * `useLiveStream` (over the pure engine); this file is the view plus its interaction state (replay).
 *
 * Accessibility, deliberately: the auto-update is pausable (WCAG 2.2.2) via a real pause/play button;
 * reduced-motion users start paused but can opt in; the moving list is `aria-live="off"` with one
 * visually-hidden summary so screen readers get context without per-row spam; and Replay is a real,
 * keyboard-operable button that produces a real local result (a "replayed N×" stamp), not a fake glyph.
 */
export function InspectorStage() {
  const { state, isPlaying, toggle } = useLiveStream();
  const [replays, setReplays] = useState<Record<string, number>>({});
  // Which event the four surfaces render. null = follow the newest row; a string = pinned by a click.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRow = (selectedId && state.rows.find((r) => r.id === selectedId)) || state.rows[0]!;

  // Forget replay marks once a row has scrolled off, so the map can't grow without bound.
  useEffect(() => {
    setReplays((prev) => {
      const ids = Object.keys(prev);
      if (ids.length === 0) return prev;
      const live = new Set(state.rows.map((r) => r.id));
      const next: Record<string, number> = {};
      for (const id of ids) {
        const count = prev[id];
        if (live.has(id) && count !== undefined) next[id] = count;
      }
      return Object.keys(next).length === ids.length ? prev : next;
    });
  }, [state.rows]);

  // If a pinned row scrolls off, fall back to following the newest again.
  useEffect(() => {
    if (selectedId && !state.rows.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [state.rows, selectedId]);

  function replay(id: string) {
    setReplays((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  }

  return (
    <section aria-labelledby="inspector-title" className={cn(container, sectionPad)}>
      <SectionHeading
        id="inspector-title"
        eyebrow="live inspector"
        title="Every webhook, the moment it lands"
      >
        A signed URL captures each request, checks its signature, and keeps it ready to replay.
        Here&rsquo;s what that looks like.
      </SectionHeading>

      <div className="mx-auto max-w-[960px]">
        <div className="overflow-hidden rounded-card border border-hairline bg-surface shadow-2">
          <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5">
            <div className="flex items-center gap-2.5 font-mono text-xs text-fg-muted">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    isPlaying ? "inspector-live-dot bg-ok" : "bg-fg-faint",
                  )}
                />
                {isPlaying ? "live" : "paused"}
              </span>
              <span aria-hidden="true" className="text-fg-faint">
                ·
              </span>
              <span className="tabular-nums">{state.counter.toLocaleString()} events</span>
            </div>
            <button
              type="button"
              onClick={toggle}
              aria-label={isPlaying ? "Pause the event stream" : "Play the event stream"}
              className={cn(
                focusRing,
                "inline-flex items-center gap-1.5 rounded-control border border-hairline px-2.5 py-1 font-mono text-xs text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
              )}
            >
              {isPlaying ? (
                <Pause size={12} aria-hidden="true" />
              ) : (
                <Play size={12} aria-hidden="true" />
              )}
              <span aria-hidden="true">{isPlaying ? "Pause" : "Play"}</span>
            </button>
          </header>

          <ul aria-live="off">
            {state.rows.map((row, index) => (
              <InspectorRow
                key={row.id}
                row={row}
                isNewest={index === 0}
                isPinned={selectedId === row.id}
                replayCount={replays[row.id] ?? 0}
                onReplay={() => replay(row.id)}
                onTogglePin={() => setSelectedId((cur) => (cur === row.id ? null : row.id))}
              />
            ))}
          </ul>

          <p className="sr-only">
            An illustrative live feed of incoming webhook events plays here, each showing its
            provider, signature status, and latency.
          </p>
        </div>

        {/* The selected event (the newest, or whichever row you click) rendered across all four
            surfaces — parity you can see, not just read. */}
        <div className="mt-4">
          <SectionEyebrow rule={false} className="mb-2.5">
            the same event, every surface
          </SectionEyebrow>
          <SurfaceCompanion row={selectedRow} />
        </div>
      </div>
    </section>
  );
}

function InspectorRow({
  row,
  isNewest,
  isPinned,
  replayCount,
  onReplay,
  onTogglePin,
}: {
  row: StreamRow;
  isNewest: boolean;
  isPinned: boolean;
  replayCount: number;
  onReplay: () => void;
  onTogglePin: () => void;
}) {
  // Only appended rows animate in; the seed rows render at rest so the first paint is calm.
  const appended = row.id.startsWith("evt-");
  return (
    <li
      data-enter={isNewest && appended ? "" : undefined}
      className={cn(
        "inspector-row relative flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-hairline px-4 py-2.5 first:border-t-0",
        // Highlight only an explicit pin; while following the newest event no row is "stuck" lit.
        isPinned && "shadow-[inset_2px_0_0_var(--wh-info)]",
      )}
    >
      {/* A faint tint sweeps the row on each replay. Keyed by count so it re-fires per click, and a
          separate layer so it never clobbers the newest row's entrance animation. */}
      {replayCount > 0 && (
        <span
          key={replayCount}
          aria-hidden="true"
          className="replay-flash pointer-events-none absolute inset-0"
        />
      )}
      {/* The badge + name pin this event into the four-surface view (toggle: press again to follow the
          newest again). A sibling of Replay — never nested — so the two controls stay independent. */}
      <button
        type="button"
        onClick={onTogglePin}
        aria-pressed={isPinned}
        aria-label={`Inspect ${row.provider} ${row.event} across surfaces`}
        className={cn(
          focusRing,
          "flex min-w-0 flex-1 items-center gap-3 rounded-control text-left",
        )}
      >
        <span
          aria-hidden="true"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-control bg-surface-sunken font-mono text-[10px] font-semibold text-fg-secondary"
        >
          {row.badge}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
          <span className="text-fg-secondary">{row.provider}</span>
          <span aria-hidden="true" className="text-fg-faint">
            {" · "}
          </span>
          {row.event}
        </span>
      </button>
      <Sig status={row.status} />
      <span className="shrink-0 font-mono text-xs tabular-nums text-fg-muted">
        {row.latencyMs}ms
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onReplay}
          aria-label={`Replay ${row.provider} ${row.event}`}
          className={cn(
            focusRing,
            "rounded-control border border-hairline px-2 py-0.5 font-mono text-[11px] text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
          )}
        >
          Replay
        </button>
        {replayCount > 0 && (
          <span className="font-mono text-[11px] text-info">replayed {replayCount}&times;</span>
        )}
      </span>
    </li>
  );
}

function Sig({ status }: { status: SigStatus }) {
  if (status.ok) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-ok">
        <span aria-hidden="true">✓</span>verified
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-danger">
      <span aria-hidden="true">✕</span>
      <span>failed — {FAIL_REASON_LABEL[status.reason]}</span>
    </span>
  );
}
