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
  /** The list-state setter the live tail prepends into (dedup + cap happen in the hook). */
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
  setItems,
  webSocketCtor,
}: LiveTailBarProps): React.ReactElement | null {
  const [live, setLive] = React.useState(false);
  const liveAvailable = liveWsUrl !== undefined && mintTicket !== undefined;

  // The live tail. `enabled` gates on the toggle AND the wiring being present; the hook auto-pauses on a
  // hidden tab / unmount and prepends+dedups+caps arrived events into `setItems`. A safe no-op mint stands in
  // when the wiring is absent (the hook stays disabled, so it never runs).
  const {
    connection,
    caughtUp,
    lag,
    error: liveError,
  } = useLiveEvents({
    enabled: live && liveAvailable,
    wsUrl: liveWsUrl ?? "",
    endpointId,
    mintTicket: mintTicket ?? UNAVAILABLE_MINT,
    setItems,
    WebSocketCtor: webSocketCtor,
  });

  if (!liveAvailable) return null;

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
