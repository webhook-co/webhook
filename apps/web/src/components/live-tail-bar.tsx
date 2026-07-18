"use client";

import { Button, cn } from "@webhook-co/ui";
import { LISTEN_LAG_CAP } from "@webhook-co/shared";
import * as React from "react";

import { useLiveEvents } from "@/lib/use-live-events";
import type { MintTicketResult, WebSocketCtor } from "@/lib/live-events";
import type { EventSummaryItem } from "@/server/events";

// The live-tail control bar: a "Go live / Stop live" toggle + an honest connection/lag indicator, over the
// useLiveEvents hook that prepends arrived events into the caller's list. Shared by BOTH the per-endpoint list
// (endpoint-scoped) and the consolidated org list (org-scoped) — the ONLY difference is whether `endpointId`
// is passed, so the two surfaces can never drift on the live UX. When the live wiring (`liveWsUrl` +
// `mintTicket`) is absent, it renders nothing and the hook stays disabled.

export interface LiveTailBarProps {
  /** The endpoint to tail, or OMITTED for an org-wide tail (the consolidated events page). */
  readonly endpointId?: string;
  /** The `wss://…/listen` URL, derived server-side. Paired with `mintTicket`; either absent → no toggle. */
  readonly liveWsUrl?: string;
  /** Mint a short-lived listen ticket — scope-agnostic + pre-bound by the page (slug[, endpointId]). */
  readonly mintTicket?: () => Promise<MintTicketResult>;
  /**
   * Whether a filter is ACTIVE on the surrounding list. Live is DISABLED while filtered: the tail streams
   * every new event (`since=now`, unfiltered — the wire summary can't carry method/eventType/search fields to
   * re-apply them client-side), so prepending them under a filter chip would contradict what the chip claims
   * the list is narrowed to. Rather than lie, the toggle is disabled with a "clear filters" nudge.
   */
  readonly filtersBlockLive?: boolean;
  /** The list-state setter the live tail prepends into (dedup happens in the hook). */
  readonly setItems: React.Dispatch<React.SetStateAction<readonly EventSummaryItem[]>>;
  /** Test seam: inject a FakeWebSocket. Undefined in the app → the browser `WebSocket`. */
  readonly webSocketCtor?: WebSocketCtor;
}

/** A stable, always-failing mint used only when the live wiring is absent (the hook stays disabled). */
const UNAVAILABLE_MINT = async (): Promise<MintTicketResult> => ({
  ok: false,
  error: "Live isn't available here.",
});

/** Render the capped backlog count: over the server cap shows `<cap>+` (matches the tail's over-cap sentinel). */
function formatBacklog(lag: { backlogCount: number } | undefined): string | null {
  if (!lag) return null;
  return lag.backlogCount > LISTEN_LAG_CAP ? `${LISTEN_LAG_CAP}+` : String(lag.backlogCount);
}

export function LiveTailBar({
  endpointId,
  liveWsUrl,
  mintTicket,
  filtersBlockLive = false,
  setItems,
  webSocketCtor,
}: LiveTailBarProps): React.ReactElement | null {
  const [live, setLive] = React.useState(false);
  const liveAvailable = liveWsUrl !== undefined && mintTicket !== undefined;

  // The live tail. `enabled` gates on the toggle AND the wiring being present AND no active filter (an
  // unfiltered `since=now` stream can't honour a filter chip). The hook auto-pauses on a hidden tab / unmount
  // and prepends+dedups arrived events into `setItems`. A safe no-op mint stands in when the wiring is absent
  // (the hook stays disabled, so it never runs).
  const {
    connection,
    caughtUp,
    lag,
    error: liveError,
  } = useLiveEvents({
    enabled: live && liveAvailable && !filtersBlockLive,
    wsUrl: liveWsUrl ?? "",
    endpointId,
    mintTicket: mintTicket ?? UNAVAILABLE_MINT,
    setItems,
    WebSocketCtor: webSocketCtor,
  });

  if (!liveAvailable) return null;

  // Live is incompatible with a filtered view (see the filtersBlockLive prop doc). Show the toggle disabled with a
  // nudge rather than stream events that contradict the active chips.
  if (filtersBlockLive) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-h-5 text-sm text-fg-muted">clear filters to watch live events.</span>
        <Button variant="primary" size="sm" disabled aria-pressed={false}>
          Go live
        </Button>
      </div>
    );
  }

  // Honest live indicator — a colored, pulsing dot + terse status. Green = caught up, amber = behind by a
  // (capped) count. We never claim "instant": new events surface within a few seconds.
  let dotTone = "bg-fg-faint";
  let pulse = false;
  let statusText = "connecting…";
  if (connection === "connected") {
    if (caughtUp) {
      dotTone = "bg-ok";
      pulse = true;
      statusText = "live · caught up";
    } else {
      const behind = formatBacklog(lag);
      dotTone = "bg-warn";
      pulse = true;
      statusText = behind ? `live · ${behind} behind` : "live · catching up";
    }
  } else if (connection === "disconnected") {
    statusText = "reconnecting…";
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-h-5 items-center gap-2 text-sm" aria-live="polite">
        {live ? (
          <>
            <span
              aria-hidden="true"
              className={cn("size-2 rounded-full", dotTone, pulse && "animate-pulse")}
            />
            <span className="text-fg-secondary">{statusText}</span>
            {liveError ? <span className="text-warn">· {liveError}</span> : null}
          </>
        ) : (
          <span className="text-fg-muted">
            new events appear within a few seconds when live is on.
          </span>
        )}
      </div>
      <Button
        variant={live ? "secondary" : "primary"}
        size="sm"
        aria-pressed={live}
        onClick={() => setLive((v) => !v)}
      >
        {live ? "Stop live" : "Go live"}
      </Button>
    </div>
  );
}
