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

/**
 * How long a paused tail may resume from its cursor before it is treated as a NEW go-live.
 *
 * A pause is an interruption — a tab switch, a screen lock, a five-minute meeting — and resuming exactly is
 * right for those: the events arrived while Live was on, so they are not history. A long absence is a
 * different thing wearing the same clothes: without a bound the ref survives indefinitely and a Friday-evening
 * Live toggle resumes on Monday by draining the whole weekend into the list — the exact history-replay this
 * feature exists to prevent.
 *
 * This bound covers the VISIBILITY path (a hide/show re-runs the connect effect). A dead socket that never
 * fired a visibilitychange — a laptop that suspended — does NOT re-run this effect; the transport enforces the
 * same bound on its own reconnect path, which is why the constant is shared with it.
 *
 * 5 minutes is a judgement call, not a derivation: long enough that every real interruption resumes
 * losslessly, short enough that no plausible backlog is a flood. Tune it here if it reads wrong in practice.
 *
 * Measured with `Date.now()` deltas ON PURPOSE: it is a DURATION on one clock, so server skew cannot touch it,
 * and unlike `performance.now()` the wall clock keeps advancing while the machine sleeps — which is precisely
 * the case being bounded.
 */
export const LIVE_RESUME_MAX_PAUSE_MS = 5 * 60 * 1000;

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

  /**
   * The last cursor this tail delivered — the resume position across a PAUSE.
   *
   * KNOWN GAP, filed not hidden: this is only populated once an event has been DELIVERED. The listen protocol
   * deliberately keeps `headCursor` HTTP-only ("a streaming client tracks position from the event-frame
   * cursors" — listen-protocol.ts), which was safe while the tail replayed from the oldest event and could
   * not lose anything. It no longer is: if the tab hides BEFORE the first event arrives, there is no cursor,
   * the resume falls back to `since=now`, and whatever landed while hidden is skipped.
   *
   * The honest fix is a protocol change — the ReadyFrame carrying the position the DO actually seeded at, so
   * a client always has one from connect, server-resolved and immune to browser clock skew. Seeding from a
   * client-side `new Date()` instead would close the gap and introduce a worse one: a laptop clock minutes
   * off silently skips or replays minutes of events.
   *
   * A ref, not state: it must survive the effect teardown/re-run that a visibility change causes, and writing
   * it must not re-render (every event would).
   */
  const lastCursorRef = React.useRef<string | null>(null);

  /**
   * Turning Live OFF ends the live intent, so the next ON is a FRESH one: `since=now`, no history. Dropping
   * the cursor here is what encodes that — without it, toggling off, waiting an hour and toggling on would
   * replay the hour, which is the history-replay the whole change removes.
   *
   * Hiding the TAB is deliberately not this. `enabled` stays true, the cursor survives, and coming back
   * resumes exactly — those events arrived while Live was on, so they are not history.
   */
  React.useEffect(() => {
    if (!enabled) lastCursorRef.current = null;
  }, [enabled]);

  /** When the tail last went inactive, so a resume can tell an interruption from an absence. */
  const pausedAtRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (active) {
      // Resuming: a pause older than the bound is not a pause. Drop the cursor so the connect below asks for
      // `since=now` and the reader starts watching again rather than replaying however long they were away.
      const pausedAt = pausedAtRef.current;
      if (pausedAt !== null && Date.now() - pausedAt > LIVE_RESUME_MAX_PAUSE_MS) {
        lastCursorRef.current = null;
      }
      pausedAtRef.current = null;
    } else {
      pausedAtRef.current = Date.now();
    }
  }, [active]);

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
      // Absent on a fresh go-live (⇒ `since=now`); set when resuming a paused tail (⇒ `sinceCursor=`).
      // Read at connect time, so the effect deps stay unchanged and a visibility flip does not re-key it.
      seedFrom: lastCursorRef.current ?? undefined,
      onCursor: (c) => (lastCursorRef.current = c),
      // The transport enforces the SAME bound on its own reconnect path (a dead socket that never fired a
      // visibilitychange, so this effect never re-ran). One constant, both paths.
      maxResumeGapMs: LIVE_RESUME_MAX_PAUSE_MS,
      WebSocketCtor,
    });
    return () => session.stop();
  }, [active, wsUrl, endpointId, mintTicket, handleEvent, WebSocketCtor]);

  return { connection, caughtUp, lag, error };
}
