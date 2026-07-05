"use client";

import type { Lag } from "@webhook-co/shared";
import * as React from "react";

import type { EventSummaryItem } from "@/server/events";

import {
  createLiveEventsSession,
  type LiveConnectionStatus,
  type MintTicketResult,
  type WebSocketCtor,
} from "./live-events";

// React wrapper over the pure live-events core. It owns enable/disable, prepends arrived events into the
// caller's list setter (DEDUPING by id so a live event that later shows up in a page load isn't doubled),
// tracks the connection + cursor-contract status for the UI indicator, and AUTO-PAUSES when the tab is
// hidden or the component unmounts — a background tab shouldn't hold an open socket or pile up rows the
// user isn't watching. The tail is read-only; it never mutates data and never meters.

export interface UseLiveEventsOptions {
  /** The user's Live toggle. `false` tears the socket down. */
  readonly enabled: boolean;
  /** The `wss://…/listen` URL (derived server-side; passed through as a prop). */
  readonly wsUrl: string;
  readonly endpointId: string;
  /** The session-authed mint action (a stable server-action reference). */
  readonly mintTicket: (endpointId: string) => Promise<MintTicketResult>;
  /** The list-state setter the live tail prepends into (dedup happens here). */
  readonly setItems: React.Dispatch<React.SetStateAction<readonly EventSummaryItem[]>>;
  /** Injected for tests (a FakeWebSocket); defaults to the browser `WebSocket`. */
  readonly WebSocketCtor?: WebSocketCtor;
}

export interface LiveEventsState {
  /** Coarse connection state for the indicator. `disconnected` covers paused/off and reconnecting. */
  readonly connection: LiveConnectionStatus;
  /** Whether the tail is caught up to the head (false → showing `backlogCount` behind). */
  readonly caughtUp: boolean;
  /** The capped backlog lag, when the engine reports one. */
  readonly lag: Lag | undefined;
  /** An unobtrusive reason the stream couldn't start (cleared once it connects); null when fine. */
  readonly error: string | null;
}

/** Read the document's current visibility (SSR-safe: treat a missing `document` as visible). */
function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

export function useLiveEvents({
  enabled,
  wsUrl,
  endpointId,
  mintTicket,
  setItems,
  WebSocketCtor,
}: UseLiveEventsOptions): LiveEventsState {
  const [connection, setConnection] = React.useState<LiveConnectionStatus>("disconnected");
  const [caughtUp, setCaughtUp] = React.useState(true);
  const [lag, setLag] = React.useState<Lag | undefined>(undefined);
  const [error, setError] = React.useState<string | null>(null);
  const [visible, setVisible] = React.useState(true);

  // Track tab visibility so a hidden tab pauses the tail (no open socket, no piled-up rows).
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = () => setVisible(isDocumentVisible());
    setVisible(isDocumentVisible());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // Prepend + dedup by id: a live event already present in the list (e.g. it also arrived via a page load)
  // is not re-added; a genuinely new one goes to the top.
  const handleEvent = React.useCallback(
    (item: EventSummaryItem) => {
      setItems((prev) => (prev.some((e) => e.id === item.id) ? prev : [item, ...prev]));
    },
    [setItems],
  );

  const active = enabled && visible;

  React.useEffect(() => {
    if (!active) {
      setConnection("disconnected");
      return;
    }
    // Reset the status readout on a fresh connect so a stale "N behind" / error doesn't linger.
    setCaughtUp(true);
    setLag(undefined);
    setError(null);
    const session = createLiveEventsSession({
      wsUrl,
      endpointId,
      mintTicket,
      onEvent: handleEvent,
      onStatus: (s) => {
        setCaughtUp(s.caughtUp);
        setLag(s.lag);
      },
      onConnectionChange: (c) => {
        setConnection(c);
        // A live connection clears any earlier "couldn't start" notice.
        if (c === "connected") setError(null);
      },
      onError: setError,
      WebSocketCtor,
    });
    return () => session.stop();
  }, [active, wsUrl, endpointId, mintTicket, handleEvent, WebSocketCtor]);

  return { connection, caughtUp, lag, error };
}
